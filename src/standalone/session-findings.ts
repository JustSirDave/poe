import { createHash } from 'node:crypto';
import type { Session } from '../core/types';
import type { ToolActivity } from '../core/tool-activity';
import type { Finding } from './analysis';

function toolName(event: ToolActivity): string {
  const value = (event.name.split('.').pop() || 'Tool').replaceAll(/[_-]+/g, ' ');
  return value.replaceAll(/\b\w/g, letter => letter.toUpperCase());
}
function outcomes(group: ToolActivity[]): string[] {
  return [...new Set(group.filter(item => item.status === 'failed').map(item => item.failureCategory || 'reported tool error'))];
}
function targetedAction(group: ToolActivity[]): string {
  const names = new Set(group.map(item => item.name.split('.').pop()!.toLowerCase())); const failures = outcomes(group);
  if (names.has('glob') && failures.includes('timeout')) return 'Narrow the search to one project folder and a more specific file pattern, then retry once. If it still times out, list candidate files first and search only that list.';
  if (names.has('edit') && failures.includes('edit target not found')) return 'Read the target section once, copy its current text, and create one updated edit. The recorded retries used text that was no longer present.';
  if (failures.includes('permission denied')) return 'Stop retrying the operation and correct the path, sandbox permission, or file ownership first. Retry once after the access condition changes.';
  if (failures.includes('command or file not found')) return 'Verify the exact command and path before retrying. Use the smallest lookup needed to establish what exists.';
  if ([...names].some(name => ['bash', 'exec_command', 'command'].includes(name)) && failures.some(item => item.startsWith('exit code'))) return 'Verify the working directory first, then run the smallest failing command once and use its exit output to choose the next step.';
  if (failures.includes('test failure')) return 'Read the first failing assertion, change the implicated code or test setup, and rerun only the affected test before broadening verification.';
  return 'Inspect the first recorded failure, identify what changed between attempts, and retry only after addressing that cause.';
}
function consolidate(findings: Finding[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.title}:${finding.suggestion}`; const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...finding, evidence: [...finding.evidence] }); continue; }
    existing.occurrences += finding.occurrences; existing.evidence.push(...finding.evidence);
    existing.sessionCount = new Set(existing.evidence.map(item => `${item.harness}:${item.sessionId}`)).size;
    existing.firstSeen = Math.min(existing.firstSeen || Infinity, finding.firstSeen || Infinity);
    existing.lastSeen = Math.max(existing.lastSeen || 0, finding.lastSeen || 0);
    existing.explanation = `This pattern was recorded ${existing.occurrences} times across ${existing.sessionCount} sessions. The examples below identify the affected projects, tool calls, and recorded outcomes.`;
  }
  return [...merged.values()];
}

/** Signals to review, not semantic judgments about progress or instruction compliance. */
export function sessionFindings(sessions: Session[], cutoff: number, now: number): Finding[] {
  const findings: Finding[] = [];
  for (const session of sessions) {
    if (session.sessionOrigin === 'guardian') continue;
    const events = (session.toolActivity || []).filter(e => e.timestamp !== null && e.timestamp >= cutoff && e.timestamp <= now && !e.polling).sort((a, b) => a.timestamp! - b.timestamp!);
    const emit = (signal: string, title: string, explanation: string, group: ToolActivity[], suggestion = 'Inspect these calls and their outcomes, then propose one targeted correction only if needed.') => {
      const first = group[0]; const last = group.at(-1)!;
      const request = [...session.requests].reverse().find(r => r.timestamp !== null && r.timestamp <= last.timestamp!);
      if (!request) return;
      const id = createHash('sha256').update(`${session.harness}:${session.sessionId}:${signal}:${first.id}`).digest('hex').slice(0, 20);
      const caution = 'This is an observed session signal, not proof of waste. Polling, deliberate verification, external changes, and permission or environment failures can justify repetition. Preserve required checks; no token savings are measured.';
      const recent = group.slice(-6); const details = recent.map(event => `${toolName(event)} · ${event.status === 'failed' ? event.failureCategory || 'reported tool error' : event.read ? 'same content returned' : 'same result returned'}`);
      findings.push({ id, kind: 'session', title, explanation, occurrences: group.length, sessionCount: 1, firstSeen: first.timestamp!, lastSeen: last.timestamp!, evidence: [{ sessionId: session.sessionId, requestId: request.requestId, harness: session.harness, workspace: session.workspaceRootPath || session.workspaceName, timestamp: last.timestamp, toolCallIds: recent.map(e => e.id), details }], suggestion, caution, draft: `# ${title}\n\n${explanation}\n\nRecommended next step: ${suggestion}\n\n${caution}` });
    };
    const groups = new Map<string, ToolActivity[]>();
    for (const event of events) {
      if (event.status === 'pending') continue;
      const category = event.status === 'failed' ? 'retry' : event.read ? 'reread' : 'repeat';
      const key = category + ':' + event.signature + (event.status === 'failed' ? '' : ':' + event.outputHash + (event.read ? ':' + event.epoch : ''));
      let group = groups.get(key) || [];
      if (group.length && event.timestamp! - group[0].timestamp! > 600000) group = [];
      group.push(event); groups.set(key, group);
    }
    const retryIds = new Set<string>();
    for (const [key, group] of groups) {
      if (key.startsWith('retry:') && group.length >= 2) {
        for (const event of group) retryIds.add(event.id);
        const result = outcomes(group).join(', '); const name = toolName(group[0]);
        emit('retry', `${name} repeated the same failed action`, `${group.length} ${name} calls used identical arguments and failed within ten minutes. Recorded outcome${outcomes(group).length === 1 ? '' : 's'}: ${result}.`, group, targetedAction(group));
      } else if (!key.startsWith('retry:') && group.length >= 3) {
        const read = key.startsWith('reread:');
        emit(read ? 'reread' : 'repeat', read ? 'The same content was read repeatedly' : 'Identical calls returned identical results', `${group.length} completed ${read ? 'read' : 'tool'} calls used identical arguments and returned identical recorded output within ten minutes.${read ? ' No intervening non-read tool call was recorded.' : ''}`, group, read ? 'Keep the first result in working context. Read the source again only after an edit, an external change, or a specific unanswered question.' : 'Reuse the first unchanged result or change the inputs deliberately before another call.');
      }
    }
    const changedRetries = new Map<string, ToolActivity[]>();
    for (const event of events.filter(item => item.status === 'failed' && !retryIds.has(item.id))) {
      const family = event.name.split('.').pop()!.toLowerCase();
      const key = `${event.turn}:${family}`;
      const group = changedRetries.get(key) || [];
      group.push(event); changedRetries.set(key, group);
    }
    for (const [key, group] of changedRetries) {
      if (group.length < 2 || new Set(group.map(item => item.signature)).size < 2
        || group.at(-1)!.timestamp! - group[0].timestamp! > 600000) continue;
      for (const event of group) retryIds.add(event.id);
      const name = toolName(group[0]); const result = outcomes(group); const title = result.length === 1 ? `${name} failed repeatedly: ${result[0]}` : `${name} failed after ${group.length} different attempts`;
      emit('changed-retry:' + key, title, `${group.length} ${name} calls used different arguments and failed within one request. Recorded outcomes: ${group.map(item => item.failureCategory || 'reported tool error').join(' → ')}.`, group, targetedAction(group));
    }
    const failures = events.filter(e => e.status === 'failed' && !retryIds.has(e.id));
    const latest = failures.at(-1)?.timestamp || 0;
    const burst = failures.filter(e => latest - e.timestamp! <= 600000);
    if (burst.length >= 3) emit('failures', 'Several different tool actions failed', `${burst.length} tool calls recorded errors within ten minutes. Recorded outcomes: ${outcomes(burst).join(', ')}.`, burst, targetedAction(burst));
    const thoughtGroups = new Map<string, NonNullable<Session['reasoningActivity']>>();
    for (const thought of (session.reasoningActivity || []).filter(item => item.timestamp !== null && item.timestamp >= cutoff && item.timestamp <= now)) {
      const key = `${thought.turn}:${thought.hash}`; const group = thoughtGroups.get(key) || []; group.push(thought); thoughtGroups.set(key, group);
    }
    const repeatedByTurn = new Map<number, NonNullable<Session['reasoningActivity']>[] >();
    for (const group of thoughtGroups.values()) {
      if (group.length < 3 || group.at(-1)!.timestamp! - group[0].timestamp! > 600000) continue;
      const groups = repeatedByTurn.get(group[0].turn) || []; groups.push(group); repeatedByTurn.set(group[0].turn, groups);
    }
    for (const [turn, groups] of repeatedByTurn) {
      const combined = groups.flat().sort((a, b) => a.timestamp! - b.timestamp!);
      if (!combined.some(item => item.excerpt)) continue;
      const first = combined[0]; const last = combined.at(-1)!;
      const request = [...session.requests].reverse().find(item => item.timestamp !== null && item.timestamp <= last.timestamp!);
      if (!request) continue;
      const id = createHash('sha256').update(`${session.harness}:${session.sessionId}:reasoning:${turn}`).digest('hex').slice(0, 20);
      findings.push({ id, kind: 'session', title: 'The same recorded reasoning returned during one task', explanation: `${groups.length} distinct inspectable reasoning ${groups.length === 1 ? 'passage was' : 'passages were'} each recorded at least three times during one request (${combined.length} records total). Review the preview to distinguish duplicated logging from a reasoning loop.`, occurrences: combined.length, sessionCount: 1, firstSeen: first.timestamp!, lastSeen: last.timestamp!, evidence: [{ sessionId: session.sessionId, requestId: request.requestId, harness: session.harness, workspace: session.workspaceRootPath || session.workspaceName, timestamp: last.timestamp, reasoningIds: combined.slice(-20).map(item => item.id), details: [`${groups.length} repeated passages · ${combined.length} records`], excerpt: combined.find(item => item.excerpt)?.excerpt }], suggestion: 'If the same plan returned without new evidence, add a checkpoint after the second repeat: state the unresolved assumption, gather one new fact, then choose a different next action.', caution: 'Poe can inspect only reasoning text or summaries recorded in local logs. Hidden or encrypted thinking is unavailable. Identical records can be logging duplication, and no token savings are measured.', draft: '# Repeated recorded reasoning\n\nInspect the preview and surrounding result. If no new evidence appeared, add a stop-and-reframe checkpoint after the second repeat.' });
    }
    for (const request of session.requests) {
      if (request.timestamp === null || request.timestamp < cutoff || request.timestamp > now) continue;
      const text = request.messageText.split('## My request:').at(-1)!.trim();
      if (text.length > 1500 || text.startsWith('<') || !/^(?:no[,!.]?\s*)?(?:you (?:ignored|did not follow|didn't follow)|that(?:'s| is) not what I (?:asked|requested)|I (?:asked|told) you (?:to|not to))\b/i.test(text)) continue;
      const event: ToolActivity = { id: request.requestId, name: '', signature: '', timestamp: request.timestamp, status: 'completed', read: false, polling: false, epoch: 0, turn: 0 };
      emit('correction', 'User corrected the assistant’s direction', 'An explicit user correction may indicate a missed instruction. Compare it with the original request and response; this is not automatic proof of noncompliance.', [event], 'Extract the specific instruction that was missed and add only that durable rule to the relevant project or personal guidance. Keep one-off task details out.');
      const finding = findings.at(-1)!; delete finding.evidence[0].toolCallIds; delete finding.evidence[0].details;
      finding.evidence[0].requestId = request.requestId;
      finding.evidence[0].contextRequestId = session.requests[Math.max(0, session.requests.indexOf(request) - 1)].requestId;
    }
  }
  return consolidate(findings);
}
