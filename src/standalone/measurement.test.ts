import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCodexSessionFile } from '../core/parser-codex';
import { parseClaudeSessionFile } from '../core/parser-claude';
import { analyzeEfficiency } from './analysis';
import { resolveConfig } from './config';

const now = Date.now();
const timestamp = new Date(now - 1000).toISOString();
const prompt = 'Inspect the failing tests, explain the cause, implement a focused fix and rerun the affected tests.';
function fixture(lines: unknown[], run: (file: string, root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-origin-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
  try { run(file, root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const user = (text: string) => ({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const answer = (text: string, channel = 'final') => ({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', channel, content: [{ type: 'output_text', text }] } });
const config = resolveConfig({}, process.cwd());

describe('coaching measurement regressions', () => {
  it('separates response-item-only turns and excludes recorded analysis from message length', () => {
    fixture([
      { type: 'session_meta', payload: { id: 'test', cwd: '/project' } },
      user(prompt), answer('x'.repeat(15000), 'analysis'), answer('Done'),
      user('Continue with the next requested task.'), answer('Verified'),
    ], (file, root) => {
      const session = parseCodexSessionFile(file, undefined, [root])!;
      expect(session.requests).toHaveLength(2);
      expect(session.requests.map(r => r.longestAssistantMessage)).toEqual([4, 8]);
      expect(analyzeEfficiency([session], { ...config, minOccurrences: 1 }, now).findings).toEqual([]);
    });
  });
  it('joins content blocks without inventing turns and does not duplicate an empty mirrored prompt', () => {
    fixture([
      user(prompt),
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: prompt } },
      answer('Done'),
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First part' }, { type: 'input_text', text: 'Second part' }] } },
      answer('Complete'),
    ], (file, root) => {
      const session = parseCodexSessionFile(file, undefined, [root])!;
      expect(session.requests).toHaveLength(2);
      expect(session.requests[1].messageText).toBe('First part\nSecond part');
    });
  });
  it('excludes guardian sessions but retains identical genuine user instructions', () => {
    fixture([{ type: 'session_meta', payload: { id: 'internal', cwd: '/project', source: { subagent: { other: 'guardian' } } } }, user(prompt), answer('Done')], (file, root) => {
      const session = parseCodexSessionFile(file, undefined, [root])!;
      expect(session.sessionOrigin).toBe('guardian');
      const sessions = ['a', 'b', 'c'].map(id => ({ ...session, sessionId: id }));
      expect(analyzeEfficiency(sessions, config, now).requestCount).toBe(0);
      const ordinary = sessions.map(s => ({ ...s, sessionOrigin: undefined }));
      expect(analyzeEfficiency(ordinary, config, now).findings[0].kind).toBe('skill');
    });
  });
  it('does not mistake a Claude file-write artifact for a long conversational message', () => {
    fixture([
      { type: 'user', uuid: 'u1', sessionId: 'claude', timestamp, cwd: '/project', message: { role: 'user', content: prompt } },
      { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Report saved.' }, { type: 'tool_use', id: 'write1', name: 'Write', input: { file_path: '/project/REPORT.md', content: 'x'.repeat(15000) } }] } },
      { type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write1', content: 'Success' }] } },
    ], (file, root) => {
      const session = parseClaudeSessionFile(file, 'project', 'project', undefined, [root])!;
      expect(session.requests[0].responseLength).toBeGreaterThan(15000);
      expect(session.requests[0].longestAssistantMessage).toBe(13);
      expect(analyzeEfficiency([session], { ...config, minOccurrences: 1 }, now).findings).toEqual([]);
    });
  });
});


it('does not propose a skill for the standard usage-limit resume notice', () => {
  const message = 'I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.';
  fixture([user(message), answer('Continuing')], (file, root) => {
    const session = parseCodexSessionFile(file, undefined, [root])!;
    const sessions = ['a', 'b', 'c'].map(id => ({ ...session, sessionId: id }));
    expect(analyzeEfficiency(sessions, config, now).findings).toEqual([]);
  });
});
