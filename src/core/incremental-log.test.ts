import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { IncrementalLog } from './incremental-log';
import { createCodexAccumulator, parseCodexSessionFile } from './parser-codex';
import { createClaudeAccumulator, parseClaudeSessionFile } from './parser-claude';
import type { Session } from './types';

function comparable(session: Session | null) {
  return session?.requests.map(r => ({ id: r.requestId, prompt: r.messageText, longest: r.longestAssistantMessage, input: r.promptTokens, output: r.completionTokens, tools: r.toolsUsed, edits: r.editedFiles }));
}
const timestamp = '2026-09-15T00:00:00Z';
describe('incremental JSONL ingestion', () => {
  it('matches a full Codex parse across append, partial UTF-8, overwrite and truncation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-cursor-'));
    const file = path.join(root, 'session.jsonl');
    const user = (text: string) => JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const answer = JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } });
    const initial = JSON.stringify({ type: 'session_meta', payload: { id: 'test', cwd: root } }) + '\n' + user('First task') + '\n' + answer + '\n' + Array(3000).fill('{"type":"ignored"}').join('\n') + '\n';
    try {
      fs.writeFileSync(file, initial);
      const reader = new IncrementalLog(() => createCodexAccumulator(file));
      expect(comparable(reader.read(file).session)).toEqual(comparable(parseCodexSessionFile(file, undefined, [root])));
      const next = Buffer.from(user('Continue café 🚀') + '\n' + answer + '\n');
      const split = next.indexOf(Buffer.from('🚀')) + 2;
      fs.appendFileSync(file, next.subarray(0, split));
      expect(reader.read(file).session?.requests).toHaveLength(1);
      fs.appendFileSync(file, next.subarray(split));
      const update = reader.read(file);
      expect(update.incremental).toBe(true);
      expect(update.bytesRead).toBeLessThan(initial.length / 2);
      expect(comparable(update.session)).toEqual(comparable(parseCodexSessionFile(file, undefined, [root])));
      fs.writeFileSync(file, user('Replacement'));
      expect(reader.read(file).incremental).toBe(false);
      expect(comparable(reader.read(file).session)).toEqual(comparable(parseCodexSessionFile(file, undefined, [root])));
      fs.appendFileSync(file, '\n' + answer);
      expect(reader.read(file).session?.requests[0].longestAssistantMessage).toBe(4);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('updates an unfinished Claude tool call when its result arrives without rereading completed turns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-claude-'));
    const file = path.join(root, 'session.jsonl');
    const user = (id: string) => ({ type: 'user', uuid: id, sessionId: 'c', cwd: root, timestamp, message: { role: 'user', content: 'Write the requested file ' + id } });
    const lines: unknown[] = [user('first'), { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Saved' }, { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/project/a.txt', content: 'hello' } }] } }];
    try {
      fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
      const reader = new IncrementalLog(() => createClaudeAccumulator(file, 'p', 'p'));
      expect(comparable(reader.read(file).session)).toEqual(comparable(parseClaudeSessionFile(file, 'p', 'p', undefined, [root])));
      fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write', content: 'Success' }] } }) + '\n' + JSON.stringify(user('second')) + '\n');
      const result = reader.read(file);
      expect(result.incremental).toBe(true);
      expect(comparable(result.session)).toEqual(comparable(parseClaudeSessionFile(file, 'p', 'p', undefined, [root])));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
