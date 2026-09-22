import { createHash } from 'node:crypto';
import type { Session, SessionRequest } from '../core/types';
import { responseContexts, type RequestContext } from './request-context';
import { sessionFindings } from './session-findings';
import { memoryFindings } from './memory-findings';
import { redactSecrets } from '../core/redact-secrets';
import type { CoachConfig } from './config';

export interface Evidence { sessionId: string; requestId: string; harness: string; workspace: string; timestamp: number | null; contextRequestId?: string; toolCallIds?: string[]; reasoningIds?: string[]; details?: string[]; excerpt?: string }
export interface Finding {
  id: string;
  firstSeen?: number;
  lastSeen?: number;
  responseIntent?: 'unclassified' | 'brevity-conflict';
  kind: 'skill' | 'memory' | 'workflow' | 'output' | 'session';
  title: string;
  explanation: string;
  occurrences: number;
  sessionCount: number;
  evidence: Evidence[];
  suggestion: string;
  caution: string;
  draft: string;
}
export interface TokenUsagePoint {
  date: string;
  harness: string;
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turnsWithInput: number;
  turnsWithOutput: number;
}
export interface HarnessActivity {
  sessions: number;
  turns: number;
  firstActivity?: number;
  lastActivity?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turnsWithInput: number;
  turnsWithOutput: number;
}
export interface CoachReport {
  generatedAt: string;
  excludedInternalSessions?: number;
  responseReview?: { requestedDetail: number; unclassified: number; brevityConflict: number };
  sessionCount: number;
  latestSessionActivity?: number;
  activeWindowDays?: number;
  toolSignalCoverage?: { retained: number; dropped: number };
  reasoningSignalCoverage?: { retained: number; dropped: number; previews: boolean };
  requestCount: number;
  harnesses: Record<string, number>;
  recordedTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; turnsWithInput: number; turnsWithOutput: number };
  usageHistory: { firstActivity?: number; lastActivity?: number; days: TokenUsagePoint[]; byHarness: Record<string, HarnessActivity> };
  findings: Finding[];
  sources: { harness: string; root: string; exists: boolean }[];
  scan: { incremental?: number; bytesRead?: number; files: number; parsed: number; reused: number; skipped: number; warnings: string[] };
}
interface Turn { session: Session; request: SessionRequest; context?: RequestContext }
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);
function localDateKey(timestamp: number): string {
  const date = new Date(timestamp); const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type UsagePoint = { date: string; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; turnsWithInput: number; turnsWithOutput: number };
interface SessionUsage {
  firstActivity?: number; lastActivity?: number;
  summary: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; turnsWithInput: number; turnsWithOutput: number };
  points: Map<string, UsagePoint>;
}
// Reused Session objects (unchanged log files) are the same object reference across scans
// (see efficiency-scan.ts's cache), so per-session token aggregation can be computed once and
// reused instead of re-walking every request on each refresh. A session's timestamps never
// change once parsed, so a cached entry stays valid for the life of that Session object; the
// rare exception is a request whose timestamp exceeds `now` at first-cache time (clock skew),
// which then stays excluded until the underlying file changes and the session is reparsed.
const sessionUsageCache = new WeakMap<Session, SessionUsage>();
function computeSessionUsage(session: Session, now: number): SessionUsage {
  const summary = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turnsWithInput: 0, turnsWithOutput: 0 };
  const points = new Map<string, UsagePoint>();
  let firstActivity: number | undefined;
  let lastActivity: number | undefined;
  for (const request of session.requests) {
    const timestamp = request.timestamp;
    if (timestamp === null || timestamp > now) continue;
    firstActivity = firstActivity === undefined ? timestamp : Math.min(firstActivity, timestamp);
    lastActivity = lastActivity === undefined ? timestamp : Math.max(lastActivity, timestamp);
    summary.turns++;
    if (request.promptTokens !== null && Number.isFinite(request.promptTokens) && request.promptTokens >= 0) { summary.input += request.promptTokens; summary.turnsWithInput++; }
    if (request.completionTokens !== null && Number.isFinite(request.completionTokens) && request.completionTokens >= 0) { summary.output += request.completionTokens; summary.turnsWithOutput++; }
    if (request.cacheReadTokens !== null && Number.isFinite(request.cacheReadTokens) && request.cacheReadTokens >= 0) summary.cacheRead += request.cacheReadTokens;
    if (request.cacheWriteTokens !== null && Number.isFinite(request.cacheWriteTokens) && request.cacheWriteTokens >= 0) summary.cacheWrite += request.cacheWriteTokens;
    const date = localDateKey(timestamp);
    const point = points.get(date) || { date, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turnsWithInput: 0, turnsWithOutput: 0 };
    point.turns++;
    if (request.promptTokens !== null && Number.isFinite(request.promptTokens) && request.promptTokens >= 0) { point.input += request.promptTokens; point.turnsWithInput++; }
    if (request.completionTokens !== null && Number.isFinite(request.completionTokens) && request.completionTokens >= 0) { point.output += request.completionTokens; point.turnsWithOutput++; }
    if (request.cacheReadTokens !== null && Number.isFinite(request.cacheReadTokens) && request.cacheReadTokens >= 0) point.cacheRead += request.cacheReadTokens;
    if (request.cacheWriteTokens !== null && Number.isFinite(request.cacheWriteTokens) && request.cacheWriteTokens >= 0) point.cacheWrite += request.cacheWriteTokens;
    points.set(date, point);
  }
  return { firstActivity, lastActivity, summary, points };
}
function usageHistory(sessions: Session[], now: number): CoachReport['usageHistory'] {
  type MutablePoint = TokenUsagePoint & { sessionIds: Set<string> };
  const points = new Map<string, MutablePoint>();
  const harnessSessions = new Map<string, Set<string>>();
  const byHarness: Record<string, HarnessActivity> = {};
  let firstActivity: number | undefined;
  let lastActivity: number | undefined;
  for (const session of sessions) {
    if (session.sessionOrigin === 'guardian') continue;
    const sessionKey = `${session.harness}:${session.sessionId}`;
    const seen = harnessSessions.get(session.harness) || new Set<string>();
    seen.add(sessionKey); harnessSessions.set(session.harness, seen);
    const summary = byHarness[session.harness] ||= { sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turnsWithInput: 0, turnsWithOutput: 0 };
    let usage = sessionUsageCache.get(session);
    if (!usage) { usage = computeSessionUsage(session, now); sessionUsageCache.set(session, usage); }
    if (usage.firstActivity !== undefined) firstActivity = firstActivity === undefined ? usage.firstActivity : Math.min(firstActivity, usage.firstActivity);
    if (usage.lastActivity !== undefined) lastActivity = lastActivity === undefined ? usage.lastActivity : Math.max(lastActivity, usage.lastActivity);
    if (usage.firstActivity !== undefined) summary.firstActivity = summary.firstActivity === undefined ? usage.firstActivity : Math.min(summary.firstActivity, usage.firstActivity);
    if (usage.lastActivity !== undefined) summary.lastActivity = summary.lastActivity === undefined ? usage.lastActivity : Math.max(summary.lastActivity, usage.lastActivity);
    summary.turns += usage.summary.turns; summary.input += usage.summary.input; summary.output += usage.summary.output;
    summary.cacheRead += usage.summary.cacheRead; summary.cacheWrite += usage.summary.cacheWrite;
    summary.turnsWithInput += usage.summary.turnsWithInput; summary.turnsWithOutput += usage.summary.turnsWithOutput;
    for (const day of usage.points.values()) {
      const key = `${day.date}:${session.harness}`;
      const point = points.get(key) || { date: day.date, harness: session.harness, sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turnsWithInput: 0, turnsWithOutput: 0, sessionIds: new Set<string>() };
      point.turns += day.turns; point.input += day.input; point.output += day.output;
      point.cacheRead += day.cacheRead; point.cacheWrite += day.cacheWrite;
      point.turnsWithInput += day.turnsWithInput; point.turnsWithOutput += day.turnsWithOutput;
      point.sessionIds.add(sessionKey);
      points.set(key, point);
    }
  }
  for (const [harness, summary] of Object.entries(byHarness)) summary.sessions = harnessSessions.get(harness)?.size || 0;
  const days = [...points.values()].map(({ sessionIds, ...point }) => ({ ...point, sessions: sessionIds.size }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.harness.localeCompare(b.harness));
  return { firstActivity, lastActivity, days, byHarness };
}

function evidence(turn: Turn, excerpts: boolean): Evidence {
  return {
    sessionId: turn.session.sessionId, requestId: turn.request.requestId,
    harness: turn.session.harness, workspace: turn.session.workspaceRootPath || turn.session.workspaceName,
    timestamp: turn.request.timestamp,
    contextRequestId: turn.context?.requestId,
    ...(excerpts ? { excerpt: redactSecrets(turn.request.messageText).slice(0, 240) } : {}),
  };
}

function createFinding(kind: Exclude<Finding['kind'], 'session'>, key: string, turns: Turn[], config: CoachConfig): Finding {
  const descriptions = {
    skill: ['Repeated instruction', 'The same substantial instruction appears in multiple sessions.', 'Turn the repeated procedure into a focused skill, or a script when its steps are deterministic.', 'Repetition can be intentional. A skill saves tokens only if it reduces loaded context or retries.'],
    memory: ['Repeated preference', 'The same instruction containing preference language appears in multiple sessions.', 'Confirm the preference is durable, then store a short scoped memory with a clear exception.', 'Do not turn a temporary task instruction into a permanent preference.'],
    workflow: ['Recurring tool sequence', 'Multiple sessions contain the same recorded tool sequence for the same work category.', 'Review these examples for a reusable procedure or script. Preserve task-specific checks.', 'Tool names alone do not prove identical work; arguments and successful outcomes must be checked.'],
    output: ['Large recorded responses', 'Several turns contain an individual assistant message above the configured character threshold. File-write payloads and recorded reasoning are excluded.', 'Use concise progress updates and targeted results where the task does not require a full artifact.', 'Long code, documents, and reasoning records can be necessary. Response size is not measured token waste.'],
  } as const;
  const [title, explanation, suggestion, caution] = descriptions[kind];
  const recent = [...turns].sort((a, b) => (b.request.timestamp || 0) - (a.request.timestamp || 0));
  const seen = new Set<string>();
  const samples = recent.filter(turn => { const key = turn.session.harness + ':' + turn.session.sessionId; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
  const id = digest(`${kind}:${key}`);
  return {
    id, kind, title, explanation, suggestion, caution, occurrences: turns.length,
    firstSeen: recent.at(-1)?.request.timestamp || undefined, lastSeen: recent[0]?.request.timestamp || undefined,
    sessionCount: new Set(turns.map(t => `${t.session.harness}:${t.session.sessionId}`)).size,
    evidence: samples.map(t => evidence(t, config.includeExcerpts)),
    draft: `# ${title}\n\nStatus: candidate, not installed or evaluated.\n\n${suggestion}\n\n## Evidence\n${samples.map(t => `- ${t.session.harness}: session ${t.session.sessionId}, request ${t.request.requestId}`).join('\n')}\n\n## Preserve quality\n- Inspect the recorded examples before deciding what can be reused.\n- Preserve the original task requirements and necessary checks.\n- Test the candidate on representative tasks; record correctness, corrections, and available token usage.\n- Keep the previous version and revert if results regress.\n\n## Limits\n${caution}\n`,
  };
}

export function analyzeEfficiency(sessions: Session[], config: CoachConfig, now = Date.now()): CoachReport {
  // Older turns may establish task context, but never count toward current findings.
  const activeWindowDays = Math.min(config.lookbackDays, 5);
  const cutoff = now - activeWindowDays * 86400000;
  const contexts = new Map(sessions.map(session => [session, responseContexts(session.requests)]));
  const turns: Turn[] = sessions.filter(session => session.sessionOrigin !== 'guardian').flatMap(session => session.requests
    .filter(request => request.timestamp !== null && request.timestamp >= cutoff && request.timestamp <= now)
    .map(request => ({ session, request, context: contexts.get(session)?.get(request.requestId) })));
  const promptGroups = new Map<string, Turn[]>();
  const workflowGroups = new Map<string, Turn[]>();
  const large: Turn[] = [];
  const concise: Turn[] = [];
  const responseReview = { requestedDetail: 0, unclassified: 0, brevityConflict: 0 };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turnsWithInput: 0, turnsWithOutput: 0 };
  const harnesses: Record<string, number> = {};
  for (const turn of turns) {
    const r = turn.request;
    harnesses[turn.session.harness] = (harnesses[turn.session.harness] || 0) + 1;
    // Note: input already folds cache reads/writes in for harnesses whose promptTokens is
    // turn-aggregate scoped (see counterScopes in analysis-dataset.ts); cacheRead/cacheWrite
    // below are the same underlying numbers broken out for display, not an additional amount.
    if (r.promptTokens !== null && Number.isFinite(r.promptTokens) && r.promptTokens >= 0) { tokens.input += r.promptTokens; tokens.turnsWithInput++; }
    if (r.completionTokens !== null && Number.isFinite(r.completionTokens) && r.completionTokens >= 0) { tokens.output += r.completionTokens; tokens.turnsWithOutput++; }
    if (r.cacheReadTokens !== null && Number.isFinite(r.cacheReadTokens) && r.cacheReadTokens >= 0) tokens.cacheRead += r.cacheReadTokens;
    if (r.cacheWriteTokens !== null && Number.isFinite(r.cacheWriteTokens) && r.cacheWriteTokens >= 0) tokens.cacheWrite += r.cacheWriteTokens;
    const message = r.messageText.trim().replaceAll(/\s+/g, ' ');
    // Exact normalized repetitions avoid merging prompts whose constraints differ.
    // Exclude truncated messages and obvious injected context.
    const resumeNotice = /^I hit my usage limit while you were working, but it has reset now\. Please continue from where you left off\.$/i.test(message);
    if (!resumeNotice && message.length >= 60 && r.messageLength <= 16000 && !message.startsWith('<') && !message.startsWith('The following is the Codex agent history whose request action you are assessing.')) {
      const key = `${turn.session.workspaceRootPath || turn.session.workspaceId}:${message}`;
      const group = promptGroups.get(key) || []; group.push(turn); promptGroups.set(key, group);
    }
    const sequence = r.toolsUsed.join(' → ');
    if (r.toolsUsed.length >= 3 && r.toolsUsed.length <= 12 && new Set(r.toolsUsed).size >= 2) {
      const key = `${turn.session.workspaceRootPath || turn.session.workspaceId}:${r.workType}:${sequence}`;
      const group = workflowGroups.get(key) || []; group.push(turn); workflowGroups.set(key, group);
    }
    if ((r.longestAssistantMessage ?? 0) >= config.largeResponseChars) {
      if (turn.context?.intent === 'requested-detail') responseReview.requestedDetail++;
      else if (turn.context?.intent === 'brevity-conflict') { responseReview.brevityConflict++; concise.push(turn); }
      else { responseReview.unclassified++; large.push(turn); }
    }
  }
  const findings: Finding[] = [...sessionFindings(sessions, cutoff, now), ...memoryFindings(sessions, cutoff, now, config)];
  for (const [key, group] of promptGroups) {
    if (group.length < config.minOccurrences || new Set(group.map(t => t.session.sessionId)).size < 2) continue;
    findings.push(createFinding('skill', key, group, config));
  }
  for (const [key, group] of workflowGroups) {
    if (group.length >= config.minOccurrences && new Set(group.map(t => t.session.sessionId)).size >= 2) findings.push(createFinding('workflow', key, group, config));
  }
  for (const [intent, group] of [['unclassified', large], ['brevity-conflict', concise]] as const) {
    if (group.length < config.minOccurrences) continue;
    const finding = createFinding('output', 'response-context-v1:' + intent, group, config);
    finding.responseIntent = intent;
    finding.explanation = intent === 'unclassified'
      ? 'These long assistant messages have no clear request-length signal. They remain unclassified: length does not establish repetition or waste.'
      : 'These long assistant messages followed requests with explicit brevity signals. Review whether required content justified the length.';
    finding.draft += '\nState each finding fully once; use finding IDs in summaries. Preserve evidence, required explanations, and verification limits.\n';
    findings.push(finding);
  }
  findings.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || b.occurrences - a.occurrences || a.id.localeCompare(b.id));
  return {
    toolSignalCoverage: { retained: sessions.reduce((n, s) => n + (s.toolActivity?.length || 0), 0), dropped: sessions.reduce((n, s) => n + (s.toolActivityDropped || 0), 0) },
    reasoningSignalCoverage: { retained: sessions.reduce((n, s) => n + (s.reasoningActivity?.length || 0), 0), dropped: sessions.reduce((n, s) => n + (s.reasoningActivityDropped || 0), 0), previews: config.includeExcerpts },
    activeWindowDays,
    latestSessionActivity: sessions.filter(s => s.sessionOrigin !== 'guardian').reduce((latest, s) => Math.max(latest, s.lastMessageDate || 0), 0) || undefined,
    generatedAt: new Date(now).toISOString(), sessionCount: new Set(turns.map(t => `${t.session.harness}:${t.session.sessionId}`)).size,
    responseReview,
    excludedInternalSessions: sessions.filter(session => session.sessionOrigin === 'guardian').length,
    requestCount: turns.length, harnesses, recordedTokens: tokens, usageHistory: usageHistory(sessions, now), findings: findings.slice(0, 40),
    sources: [], scan: { files: 0, parsed: 0, reused: 0, skipped: 0, warnings: [] },
  };
}
