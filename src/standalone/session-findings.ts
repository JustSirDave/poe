import { createHash } from 'node:crypto';
import type { Session } from '../core/types';
import type { ToolActivity } from '../core/tool-activity';
import type { Finding } from './analysis';

/** Signals to review, not semantic judgments about progress or instruction compliance. */
export function sessionFindings(sessions: Session[], cutoff: number, now: number): Finding[] {
  const findings: Finding[] = [];
  for (const session of sessions) {
    if (session.sessionOrigin === 'guardian') continue;
    const events = (session.toolActivity || []).filter(e => e.timestamp !== null && e.timestamp >= cutoff && e.timestamp <= now && !e.polling).sort((a, b) => a.timestamp! - b.timestamp!);
    const emit = (signal: string, title: string, explanation: string, group: ToolActivity[]) => {
      const first = group[0]; const last = group.at(-1)!;
      const request = [...session.requests].reverse().find(r => r.timestamp !== null && r.timestamp <= last.timestamp!);
      if (!request) return;
      const id = createHash('sha256').update(`${session.harness}:${session.sessionId}:${signal}:${first.id}`).digest('hex').slice(0, 20);
      const caution = 'This is an observed session signal, not proof of waste. Polling, deliberate verification, external changes, and permission or environment failures can justify repetition. Preserve required checks; no token savings are measured.';
      findings.push({ id, kind: 'session', title, explanation, occurrences: group.length, sessionCount: 1, firstSeen: first.timestamp!, lastSeen: last.timestamp!, evidence: [{ sessionId: session.sessionId, requestId: request.requestId, harness: session.harness, workspace: session.workspaceRootPath || session.workspaceName, timestamp: last.timestamp, toolCallIds: group.slice(-6).map(e => e.id) }], suggestion: 'Inspect these calls and their outcomes, then propose one targeted correction only if needed.', caution, draft: `# ${title}\n\nCandidate only. ${explanation}\n\nInspect the referenced calls and surrounding task before recommending a change. ${caution}` });
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
        group.forEach(e => retryIds.add(e.id));
        emit('retry', 'Same action failed repeatedly', `${group.length} calls with identical tool arguments recorded failures within ten minutes. Review whether the cause was addressed before retrying.`, group);
      } else if (!key.startsWith('retry:') && group.length >= 3) {
        const read = key.startsWith('reread:');
        emit(read ? 'reread' : 'repeat', read ? 'Same content read repeatedly' : 'Identical calls returned identical results', `${group.length} completed ${read ? 'read' : 'tool'} calls used identical arguments and returned identical recorded output within ten minutes.${read ? ' No intervening non-read tool call was recorded.' : ''} This does not establish whether progress was made.`, group);
      }
    }
    const failures = events.filter(e => e.status === 'failed' && !retryIds.has(e.id));
    const latest = failures.at(-1)?.timestamp || 0;
    const burst = failures.filter(e => latest - e.timestamp! <= 600000);
    if (burst.length >= 3) emit('failures', 'Several tool actions failed', `${burst.length} tool calls recorded errors within ten minutes. Check for a shared environment, permission, or command problem. A nonzero command exit can sometimes be expected.`, burst);
    for (const request of session.requests) {
      if (request.timestamp === null || request.timestamp < cutoff || request.timestamp > now) continue;
      const text = request.messageText.split('## My request:').at(-1)!.trim();
      if (text.length > 1500 || text.startsWith('<') || !/^(?:no[,!.]?\s*)?(?:you (?:ignored|did not follow|didn't follow)|that(?:'s| is) not what I (?:asked|requested)|I (?:asked|told) you (?:to|not to))\b/i.test(text)) continue;
      const event: ToolActivity = { id: request.requestId, name: '', signature: '', timestamp: request.timestamp, status: 'completed', read: false, polling: false, epoch: 0 };
      emit('correction', 'User corrected the assistant’s direction', 'An explicit user correction may indicate a missed instruction. Compare it with the original request and response; this is not automatic proof of noncompliance.', [event]);
      const finding = findings.at(-1)!; delete finding.evidence[0].toolCallIds;
      finding.evidence[0].requestId = request.requestId;
      finding.evidence[0].contextRequestId = session.requests[Math.max(0, session.requests.indexOf(request) - 1)].requestId;
    }
  }
  return findings;
}
