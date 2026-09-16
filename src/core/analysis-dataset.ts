import { createHash } from 'node:crypto';
import { redactSecrets } from './redact-secrets';
import type { ModelUsage, Session, SessionRequest } from './types';

export type TokenCounterScope =
  | 'turn-delta'
  | 'turn-aggregate'
  | 'last-agentic-round'
  | 'session-total'
  | 'unavailable'
  | 'unknown';

export interface AnalysisTokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  inputScope: TokenCounterScope;
  outputScope: TokenCounterScope;
  sourceReported: true;
}

export interface AnalysisTurn {
  turnId: string;
  sessionId: string;
  sourceRequestId: string;
  index: number;
  timestamp: number | null;
  modelId: string;
  agentMode: string;
  workType: string;
  canceled: boolean;
  endState?: SessionRequest['endState'];
  firstProgressMs: number | null;
  elapsedMs: number | null;
  messageLength: number;
  responseLength: number;
  longestAssistantMessage?: number;
  promptHash: string;
  responseHash: string;
  promptPreview?: string;
  responsePreview?: string;
  toolsUsed: string[];
  editedFileCount: number;
  referencedFileCount: number;
  skillsUsed: string[];
  reasoningEffort?: SessionRequest['reasoningEffort'];
  tokens: AnalysisTokenUsage;
}

export interface AnalysisSession {
  sessionId: string;
  sourceSessionId: string;
  harness: string;
  workspace: string;
  createdAt: number | null;
  lastActivityAt: number | null;
  requestCount: number;
  endReason: Session['endReason'];
  launcherKind?: Session['launcherKind'];
  entrypoint?: string;
  sessionOrigin?: string;
  modelUsage?: Record<string, ModelUsage>;
}

export interface AnalysisToolEvent {
  eventId: string;
  sessionId: string;
  turnIndex: number;
  toolCallId: string;
  name: string;
  signature: string;
  timestamp: number | null;
  status: 'pending' | 'completed' | 'failed';
  outputHash?: string;
  failureCategory?: string;
  exitCode?: number;
  read: boolean;
  polling: boolean;
  epoch: number;
}

export interface AnalysisReasoningEvent {
  eventId: string;
  sessionId: string;
  turnIndex: number;
  sourceReasoningId: string;
  hash: string;
  timestamp: number | null;
  length: number;
  preview?: string;
}

export interface AnalysisDataset {
  schemaVersion: 1;
  generatedAt: string;
  contentMode: 'metadata' | 'preview';
  sessions: AnalysisSession[];
  turns: AnalysisTurn[];
  toolEvents: AnalysisToolEvent[];
  reasoningEvents: AnalysisReasoningEvent[];
  coverage: {
    sessions: number;
    turns: number;
    turnsWithInput: number;
    turnsWithOutput: number;
    toolEventsRetained: number;
    toolEventsDropped: number;
    reasoningEventsRetained: number;
    reasoningEventsDropped: number;
    reasoningPreviews: boolean;
  };
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const preview = (value: string): string => redactSecrets(value).trim().replaceAll(/\s+/g, ' ').slice(0, 240);

function counterScopes(harness: string): Pick<AnalysisTokenUsage, 'inputScope' | 'outputScope'> {
  const normalized = harness.toLowerCase();
  if (normalized === 'codex') return { inputScope: 'turn-delta', outputScope: 'turn-delta' };
  if (normalized === 'claude') return { inputScope: 'turn-aggregate', outputScope: 'turn-aggregate' };
  if (normalized.includes('vs code')) return { inputScope: 'last-agentic-round', outputScope: 'turn-aggregate' };
  if (normalized.includes('copilot')) return { inputScope: 'unavailable', outputScope: 'turn-aggregate' };
  return { inputScope: 'unknown', outputScope: 'unknown' };
}

function sessionKey(session: Session): string {
  return `${session.harness}:${session.sessionId}`;
}

function analysisSession(session: Session, id: string): AnalysisSession {
  return {
    sessionId: id,
    sourceSessionId: session.sessionId,
    harness: session.harness,
    workspace: session.workspaceRootPath || session.workspaceName,
    createdAt: session.creationDate,
    lastActivityAt: session.lastMessageDate,
    requestCount: session.requestCount,
    endReason: session.endReason,
    launcherKind: session.launcherKind,
    entrypoint: session.entrypoint,
    sessionOrigin: session.sessionOrigin,
    modelUsage: session.modelUsage,
  };
}

function analysisTurn(input: { session: Session; id: string; request: SessionRequest; index: number; includePreviews: boolean }): AnalysisTurn {
  const { session, id, request, index, includePreviews } = input;
  return {
    turnId: `${id}:${request.requestId}`,
    sessionId: id,
    sourceRequestId: request.requestId,
    index: index + 1,
    timestamp: request.timestamp,
    modelId: request.modelId,
    agentMode: request.agentMode,
    workType: request.workType,
    canceled: request.isCanceled,
    endState: request.endState,
    firstProgressMs: request.firstProgress,
    elapsedMs: request.totalElapsed,
    messageLength: request.messageLength,
    responseLength: request.responseLength,
    longestAssistantMessage: request.longestAssistantMessage,
    promptHash: digest(request.messageText),
    responseHash: digest(request.responseText),
    ...(includePreviews ? { promptPreview: preview(request.messageText), responsePreview: preview(request.responseText) } : {}),
    toolsUsed: [...request.toolsUsed],
    editedFileCount: new Set(request.editedFiles).size,
    referencedFileCount: new Set(request.referencedFiles).size,
    skillsUsed: [...request.skillsUsed],
    reasoningEffort: request.reasoningEffort,
    tokens: {
      input: request.promptTokens,
      output: request.completionTokens,
      cacheRead: request.cacheReadTokens,
      cacheWrite: request.cacheWriteTokens,
      ...counterScopes(session.harness),
      sourceReported: true,
    },
  };
}

function analysisToolEvents(session: Session, id: string): AnalysisToolEvent[] {
  return (session.toolActivity || []).map(event => ({
    eventId: `${id}:tool:${event.id}`,
    sessionId: id,
    turnIndex: event.turn,
    toolCallId: event.id,
    name: event.name,
    signature: event.signature,
    timestamp: event.timestamp,
    status: event.status,
    outputHash: event.outputHash,
    failureCategory: event.failureCategory,
    exitCode: event.exitCode,
    read: event.read,
    polling: event.polling,
    epoch: event.epoch,
  }));
}

function analysisReasoningEvents(session: Session, id: string, includePreviews: boolean): AnalysisReasoningEvent[] {
  return (session.reasoningActivity || []).map(event => ({
    eventId: `${id}:reasoning:${event.id}`,
    sessionId: id,
    turnIndex: event.turn,
    sourceReasoningId: event.id,
    hash: event.hash,
    timestamp: event.timestamp,
    length: event.length,
    ...(includePreviews && event.excerpt ? { preview: event.excerpt } : {}),
  }));
}

function sessionRecords(session: Session, includePreviews: boolean) {
  const id = sessionKey(session);
  return {
    session: analysisSession(session, id),
    turns: session.requests.map((request, index) => analysisTurn({ session, id, request, index, includePreviews })),
    tools: analysisToolEvents(session, id),
    reasoning: analysisReasoningEvents(session, id, includePreviews),
  };
}

export function buildAnalysisDataset(
  sessions: Session[],
  options: { includePreviews?: boolean; now?: number } = {},
): AnalysisDataset {
  const includePreviews = options.includePreviews === true;
  const records = sessions.map(session => sessionRecords(session, includePreviews));
  const analysisSessions = records.map(record => record.session);
  const turns = records.flatMap(record => record.turns);
  const toolEvents = records.flatMap(record => record.tools);
  const reasoningEvents = records.flatMap(record => record.reasoning);
  const toolEventsDropped = sessions.reduce((count, session) => count + (session.toolActivityDropped || 0), 0);
  const reasoningEventsDropped = sessions.reduce((count, session) => count + (session.reasoningActivityDropped || 0), 0);

  return {
    schemaVersion: 1,
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    contentMode: includePreviews ? 'preview' : 'metadata',
    sessions: analysisSessions,
    turns,
    toolEvents,
    reasoningEvents,
    coverage: {
      sessions: analysisSessions.length,
      turns: turns.length,
      turnsWithInput: turns.filter(turn => turn.tokens.input !== null).length,
      turnsWithOutput: turns.filter(turn => turn.tokens.output !== null).length,
      toolEventsRetained: toolEvents.length,
      toolEventsDropped,
      reasoningEventsRetained: reasoningEvents.length,
      reasoningEventsDropped,
      reasoningPreviews: includePreviews,
    },
  };
}
