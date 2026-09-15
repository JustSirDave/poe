import { describe, expect, it } from 'vitest';
import { observeTools } from '../core/tool-activity';
import { createRequest, createSession } from '../core/parser-shared';
import { sessionFindings } from './session-findings';
const now = Date.now();
function fixture(harness: 'codex' | 'claude' = 'codex') {
  const session = createSession({ sessionId: 's', workspaceId: 'p', workspaceName: 'p', harness: harness === 'codex' ? 'Codex' : 'Claude', requests: [createRequest({ requestId: 'r', timestamp: now - 10000, messageText: 'Fix the failing test', responseText: '' })] });
  const parser = observeTools({ append() {}, snapshot: () => session }, harness);
  const append = (value: unknown) => parser.append(JSON.stringify(value));
  function call(id: string, name = 'Read', input: unknown = { file_path: '/secret/project.txt' }) {
    append(harness === 'codex' ? { type: 'response_item', timestamp: now - 1000, payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } } : { type: 'assistant', timestamp: now - 1000, message: { content: [{ type: 'tool_use', id, name, input }] } });
  }
  function result(id: string, failed = false) {
    append(harness === 'codex' ? { type: 'response_item', timestamp: now, payload: { type: 'function_call_output', call_id: id, output: `Process exited with code ${failed ? 1 : 0}\nprivate output` } } : { type: 'user', timestamp: now, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'private output' }] } });
  }
  return { parser, call, result, session, findings: () => sessionFindings([parser.snapshot()!], now - 5 * 86400000, now) };
}
describe('within-session signals', () => {
  it.each(['codex', 'claude'] as const)('tracks %s outcomes, deduplicates IDs, and excludes pending calls', harness => {
    const f = fixture(harness); f.call('a'); f.call('a'); f.call('b');
    expect(f.findings()).toEqual([]);
    f.result('a', true); f.result('b', true);
    expect(f.findings()[0].title).toBe('Same action failed repeatedly');
    expect(f.findings()[0].evidence[0].toolCallIds).toEqual(['a', 'b']);
    expect(JSON.stringify(f.parser.snapshot()?.toolActivity)).not.toMatch(/secret|private output/);
  });
  it('flags identical reads but resets them after another action and ignores polling', () => {
    const f = fixture(); for (const id of ['a', 'b', 'c']) { f.call(id); f.result(id); }
    expect(f.findings()[0].title).toBe('Same content read repeatedly');
    const g = fixture(); for (const id of ['a', 'b', 'c']) { g.call(id); g.result(id); g.call(id + '-edit', 'Edit'); g.result(id + '-edit'); }
    expect(g.findings().some(item => item.title === 'Same content read repeatedly')).toBe(false);
    const p = fixture(); for (const id of ['a', 'b', 'c']) { p.call(id, 'write_stdin'); p.result(id, true); }
    expect(p.findings()).toEqual([]);
  });
  it('distinguishes failure bursts and repeated non-read results', () => {
    const f = fixture(); for (const id of ['a', 'b', 'c']) { f.call(id, 'exec_command', { cmd: id }); f.result(id, true); }
    expect(f.findings()[0].title).toBe('Several tool actions failed');
    const g = fixture(); for (const id of ['a', 'b', 'c']) { g.call(id, 'exec_command', { cmd: 'same' }); g.result(id); }
    expect(g.findings()[0].title).toBe('Identical calls returned identical results');
  });
  it('recognizes a user correction without claiming a violation and expires old events', () => {
    const f = fixture(); f.session.requests[0].messageText = 'You ignored my instruction to preserve the tests.';
    expect(f.findings()[0].explanation).toContain('not automatic proof');
    f.session.requests[0].timestamp = now - 6 * 86400000;
    expect(f.findings()).toEqual([]);
    f.call('a'); f.result('a', true); f.call('b'); f.result('b', true);
    expect(sessionFindings([f.parser.snapshot()!], now, now)).toEqual([]);
  });
  it('bounds retained metadata', () => {
    const f = fixture(); for (let i = 0; i < 2002; i++) f.call(String(i));
    expect(f.parser.snapshot()?.toolActivity).toHaveLength(2000);
    expect(f.parser.snapshot()?.toolActivityDropped).toBe(2);
  });
});

it('recognizes structured exit codes without interpreting error words as failures', () => {
  const f = fixture();
  for (const id of ['a', 'b']) {
    f.call(id, 'exec_command');
    f.parser.append(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code: 1, output: 'failed' }) } }));
  }
  expect(f.findings()[0].title).toBe('Same action failed repeatedly');
  const g = fixture();
  for (const id of ['a', 'b']) {
    g.call(id, 'exec_command');
    g.parser.append(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'Documentation describes an error' } }));
  }
  expect(g.findings()).toEqual([]);
});
