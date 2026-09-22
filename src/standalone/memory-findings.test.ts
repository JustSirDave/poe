import { describe, expect, it } from 'vitest';
import { createRequest, createSession } from '../core/parser-shared';
import { resolveConfig } from './config';
import { memoryFindings } from './memory-findings';

const now = Date.now();
const cutoff = now - 5 * 86400000;
const config = resolveConfig({ includeExcerpts: true }, process.cwd());
function session(id: string, text: string, ageDays = 1) {
  return createSession({ sessionId: id, workspaceId: 'p', workspaceName: 'p', harness: 'Codex', requests: [createRequest({ requestId: id, timestamp: now - ageDays * 86400000, messageText: text, responseText: '' })] });
}

describe('memory coaching', () => {
  it('suggests memory only for a repeated explicit preference across current sessions', () => {
    const findings = memoryFindings([session('a', 'Always keep progress updates brief.'), session('b', 'Always keep progress updates brief.')], cutoff, now, config);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Repeated preference may belong in memory');
    expect(findings[0].evidence[0].excerpt).toContain('Always keep progress updates brief');
  });

  it('detects current conflicts and uses older statements only as supporting context', () => {
    const current = memoryFindings([session('a', 'Always open the browser.'), session('b', 'Never open the browser.')], cutoff, now, config);
    expect(current.some(finding => finding.title === 'Recent preferences may conflict')).toBe(true);

    const stale = memoryFindings([session('a', 'Always open the browser.'), session('b', 'Never open the browser.', 12)], cutoff, now, config);
    expect(stale.some(finding => finding.title === 'An earlier preference may be stale')).toBe(true);
    expect(memoryFindings([session('a', 'Always open the browser.', 12), session('b', 'Never open the browser.', 14)], cutoff, now, config)).toEqual([]);
  });

  it('ignores ordinary task instructions and never needs project documents', () => {
    expect(memoryFindings([session('a', 'Fix this bug and do not assume the cause.'), session('b', 'Fix this bug and do not assume the cause.')], cutoff, now, config)).toEqual([]);
  });

  it('still catches a trigger phrase that opens a later clause, not just the sentence', () => {
    const text = 'Optimize this function, and remember to always keep responses concise.';
    const findings = memoryFindings([session('a', text), session('b', text)], cutoff, now, config);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Repeated preference may belong in memory');
  });
});
