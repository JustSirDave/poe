import { createHash } from 'node:crypto';
import type { Session } from '../core/types';
import { redactSecrets } from '../core/redact-secrets';
import type { CoachConfig } from './config';
import type { Evidence, Finding } from './analysis';

interface Preference { session: Session; requestId: string; timestamp: number; action: string; negative: boolean; text: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);

function preferences(sessions: Session[], historyCutoff: number, now: number): Preference[] {
  const result: Preference[] = [];
  for (const session of sessions) {
    if (session.sessionOrigin === 'guardian') continue;
    for (const request of session.requests) {
      if (request.timestamp === null || request.timestamp < historyCutoff || request.timestamp > now || request.messageLength > 16000) continue;
      const text = request.messageText.split('## My request:').at(-1)!;
      if (text.trimStart().startsWith('<')) continue;
      for (const raw of text.split(/\r?\n|(?<=[.!?])\s+/).slice(0, 100)) {
        const line = raw.replace(/^[\s>*_#\d.)-]+/, '').replace(/[\s.!]+$/, '').trim();
        let match = line.match(/^(?:please\s+)?(always|never)\s+(.{4,240})$/i);
        let negative = match?.[1].toLowerCase() === 'never'; let action = match?.[2];
        if (!match) { match = line.match(/^I want you to\s+(always|never)\s+(.{4,240})$/i); negative = match?.[1].toLowerCase() === 'never'; action = match?.[2]; }
        if (!match) { match = line.match(/^I prefer\s+(not\s+to\s+)?(.{4,240})$/i); negative = !!match?.[1]; action = match?.[2]; }
        if (!match) { match = line.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.{4,240})$/i); negative = /^(?:do not|don't|never)\b/i.test(match?.[1] || ''); action = match?.[1]?.replace(/^(?:do not|don't|never)\s+/i, ''); }
        if (!match) { match = line.match(/^from now on[,]?\s+(.{4,240})$/i); negative = /^(?:do not|don't|never)\b/i.test(match?.[1] || ''); action = match?.[1]?.replace(/^(?:do not|don't|never)\s+/i, ''); }
        if (!action) continue;
        const normalized = action.toLowerCase().replaceAll(/\b(?:please|kindly)\b/g, '').replaceAll(/[^a-z0-9]+/g, ' ').trim();
        if (normalized.length < 4) continue;
        result.push({ session, requestId: request.requestId, timestamp: request.timestamp, action: normalized, negative, text: line });
      }
    }
  }
  return result;
}

function evidence(item: Preference, excerpts: boolean): Evidence {
  return { sessionId: item.session.sessionId, requestId: item.requestId, harness: item.session.harness,
    workspace: item.session.workspaceRootPath || item.session.workspaceName, timestamp: item.timestamp,
    ...(excerpts ? { excerpt: redactSecrets(item.text).slice(0, 240) } : {}) };
}

/** Session prompts only. Project documentation and external memory stores are never opened. */
export function memoryFindings(sessions: Session[], activeCutoff: number, now: number, config: CoachConfig): Finding[] {
  const all = preferences(sessions, now - 30 * 86400000, now);
  const byAction = new Map<string, Preference[]>();
  for (const item of all) { const group = byAction.get(item.action) || []; group.push(item); byAction.set(item.action, group); }
  const findings: Finding[] = [];
  for (const [action, group] of byAction) {
    const current = group.filter(item => item.timestamp >= activeCutoff);
    if (!current.length) continue;
    for (const polarity of [false, true]) {
      const same = current.filter(item => item.negative === polarity);
      if (same.length < 2 || new Set(same.map(item => `${item.session.harness}:${item.session.sessionId}`)).size < 2) continue;
      const recent = [...same].sort((a, b) => b.timestamp - a.timestamp);
      findings.push({ id: digest(`memory:repeat:${polarity}:${action}`), kind: 'memory', title: 'Repeated preference may belong in memory', explanation: `The same explicit ${polarity ? 'avoidance' : 'preference'} appeared in ${same.length} current sessions. This is evidence of repetition, not proof that it should be permanent.`, occurrences: same.length, sessionCount: new Set(same.map(item => item.session.sessionId)).size, firstSeen: recent.at(-1)!.timestamp, lastSeen: recent[0].timestamp, evidence: recent.slice(0, 3).map(item => evidence(item, config.includeExcerpts)), suggestion: 'Confirm that the preference is durable and broadly scoped, then save one concise memory with an exception or expiry condition.', caution: 'Poe reads explicit preference statements from session prompts only. It does not read project documentation or existing agent memory files, and it cannot know whether a preference was temporary.', draft: '# Repeated preference\n\nCandidate only. Confirm scope, exceptions, and durability before storing this as memory.' });
    }
    const positive = group.filter(item => !item.negative); const negative = group.filter(item => item.negative);
    if (!positive.length || !negative.length) continue;
    const recent = [...group].sort((a, b) => b.timestamp - a.timestamp);
    const currentConflict = positive.some(item => item.timestamp >= activeCutoff) && negative.some(item => item.timestamp >= activeCutoff);
    findings.push({ id: digest(`memory:conflict:${action}`), kind: 'memory', title: currentConflict ? 'Recent preferences may conflict' : 'An earlier preference may be stale', explanation: currentConflict ? 'Opposite explicit preferences about the same normalized action appear in the current five-day window.' : 'A current explicit preference conflicts with an older statement. The current statement triggered this review; the older one is supporting context only.', occurrences: current.length, sessionCount: new Set(group.map(item => item.session.sessionId)).size, firstSeen: recent.at(-1)!.timestamp, lastSeen: recent[0].timestamp, evidence: recent.slice(0, 3).map(item => evidence(item, config.includeExcerpts)), suggestion: 'Review both statements and keep one scoped preference. Add an exception when both are valid in different contexts.', caution: 'Normalization can merge statements whose context differs. This finding does not edit or inspect existing memory; verify the original requests before changing anything.', draft: '# Preference conflict\n\nCandidate only. Compare context and recency, then propose one scoped memory or no change.' });
  }
  return findings;
}
