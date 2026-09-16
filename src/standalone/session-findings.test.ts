import { describe, expect, it } from 'vitest';
import { observeTools } from '../core/tool-activity';
import { createRequest, createSession } from '../core/parser-shared';
import { sessionFindings } from './session-findings';
const now = Date.now();
function fixture(harness: 'codex' | 'claude' = 'codex', includeExcerpts = false) {
  const session = createSession({ sessionId: 's', workspaceId: 'p', workspaceName: 'p', harness: harness === 'codex' ? 'Codex' : 'Claude', requests: [createRequest({ requestId: 'r', timestamp: now - 10000, messageText: 'Fix the failing test', responseText: '' })] });
  const parser = observeTools({ append() {}, snapshot: () => session }, harness, includeExcerpts);
  const append = (value: unknown) => parser.append(JSON.stringify(value));
  function call(id: string, name = 'Read', input: unknown = { file_path: '/secret/project.txt' }) {
    append(harness === 'codex' ? { type: 'response_item', timestamp: now - 1000, payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } } : { type: 'assistant', timestamp: now - 1000, message: { content: [{ type: 'tool_use', id, name, input }] } });
  }
  function result(id: string, failed = false) {
    append(harness === 'codex' ? { type: 'response_item', timestamp: now, payload: { type: 'function_call_output', call_id: id, output: `Process exited with code ${failed ? 1 : 0}\nprivate output` } } : { type: 'user', timestamp: now, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'private output' }] } });
  }
  return { parser, append, call, result, session, findings: () => sessionFindings([parser.snapshot()!], now - 5 * 86400000, now) };
}
describe('within-session signals', () => {
  it.each(['codex', 'claude'] as const)('tracks %s outcomes, deduplicates IDs, and excludes pending calls', harness => {
    const f = fixture(harness); f.call('a'); f.call('a'); f.call('b');
    expect(f.findings()).toEqual([]);
    f.result('a', true); f.result('b', true);
    expect(f.findings()[0].title).toBe('Read repeated the same failed action');
    expect(f.findings()[0].evidence[0].toolCallIds).toEqual(['a', 'b']);
    expect(f.findings()[0].evidence[0].details).toHaveLength(2);
    expect(JSON.stringify(f.parser.snapshot()?.toolActivity)).not.toMatch(/secret|private output/);
  });
  it('flags identical reads but resets them after another action and ignores polling', () => {
    const f = fixture(); for (const id of ['a', 'b', 'c']) { f.call(id); f.result(id); }
    expect(f.findings()[0].title).toBe('The same content was read repeatedly');
    const g = fixture(); for (const id of ['a', 'b', 'c']) { g.call(id); g.result(id); g.call(id + '-edit', 'Edit'); g.result(id + '-edit'); }
    expect(g.findings().some(item => item.title === 'The same content was read repeatedly')).toBe(false);
    const p = fixture(); for (const id of ['a', 'b', 'c']) { p.call(id, 'write_stdin'); p.result(id, true); }
    expect(p.findings()).toEqual([]);
  });
  it('distinguishes failure bursts and repeated non-read results', () => {
    const f = fixture(); for (const [id, name] of [['a', 'exec_command'], ['b', 'write_file'], ['c', 'browser_click']]) { f.call(id, name, { target: id }); f.result(id, true); }
    expect(f.findings()[0].title).toBe('Several different tool actions failed');
    const g = fixture(); for (const id of ['a', 'b', 'c']) { g.call(id, 'exec_command', { cmd: 'same' }); g.result(id); }
    expect(g.findings()[0].title).toBe('Identical calls returned identical results');
  });
  it('reviews changed retries only within the same user turn', () => {
    const f = fixture();
    f.call('a', 'exec_command', { cmd: 'first' }); f.result('a', true);
    f.call('b', 'exec_command', { cmd: 'second' }); f.result('b', true);
    expect(f.findings()[0].title).toContain('Exec Command failed repeatedly');
    expect(f.findings()[0].suggestion).toContain('working directory');

    const g = fixture();
    g.append({ type: 'event_msg', timestamp: now - 2000, payload: { type: 'user_message', message: 'First task' } });
    g.call('a', 'exec_command', { cmd: 'first' }); g.result('a', true);
    g.append({ type: 'event_msg', timestamp: now - 1500, payload: { type: 'user_message', message: 'Second task' } });
    g.call('b', 'exec_command', { cmd: 'second' }); g.result('b', true);
    expect(g.findings()).toEqual([]);
  });
  it.each(['codex', 'claude'] as const)('observes only recorded %s reasoning and detects a repeated passage', harness => {
    const f = fixture(harness, true);
    for (let i = 0; i < 3; i++) {
      const stamp = now - 3000 + i * 100;
      f.append(harness === 'codex'
        ? { type: 'event_msg', timestamp: stamp, payload: { type: 'agent_reasoning', text: 'Recheck the same plan with token sk-12345678901234567890.' } }
        : { type: 'assistant', timestamp: stamp, message: { content: [{ type: 'thinking', thinking: 'Recheck the same plan with token sk-12345678901234567890.' }] } });
    }
    const finding = f.findings().find(item => item.title === 'The same recorded reasoning returned during one task');
    expect(finding?.occurrences).toBe(3);
    expect(finding?.evidence[0].reasoningIds).toHaveLength(3);
    expect(finding?.evidence[0].excerpt).not.toContain('sk-12345678901234567890');
  });
  it('does not treat encrypted reasoning as readable text', () => {
    const f = fixture('codex', true);
    f.append({ type: 'response_item', timestamp: now, payload: { type: 'reasoning', encrypted_content: 'encrypted-only' } });
    expect(f.parser.snapshot()?.reasoningActivity).toEqual([]);
  });
  it('does not surface repeated reasoning when no inspectable preview exists', () => {
    const f = fixture('codex', false);
    for (let i = 0; i < 3; i++) f.append({ type: 'event_msg', timestamp: now - 3000 + i * 100, payload: { type: 'agent_reasoning', text: 'Same private reasoning' } });
    expect(f.findings()).toEqual([]);
  });
  it('merges the same actionable failure across sessions', () => {
    const first = fixture('claude'); first.session.sessionId = 'one';
    const second = fixture('claude'); second.session.sessionId = 'two';
    for (const target of [first, second]) for (const id of ['a', 'b']) { target.call(id, 'Glob', { pattern: '**/*' }); target.result(id, true); }
    const findings = sessionFindings([first.parser.snapshot()!, second.parser.snapshot()!], now - 5 * 86400000, now);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ occurrences: 4, sessionCount: 2 });
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
  expect(f.findings()[0].title).toBe('Exec Command repeated the same failed action');
  const g = fixture();
  for (const id of ['a', 'b']) {
    g.call(id, 'exec_command');
    g.parser.append(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'Documentation describes an error' } }));
  }
  expect(g.findings()).toEqual([]);
});

it('extracts an exit code from nested Claude tool-result content', () => {
  const f = fixture('claude');
  for (const [id, code] of [['a', 6], ['b', 1]] as const) {
    f.call(id, 'Bash', { command: `task-${id}` });
    f.append({ type: 'user', timestamp: now, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: [{ type: 'text', text: `Process exited with code ${code}\nprivate output` }] }] } });
  }
  expect(f.findings()[0].evidence[0].details).toEqual(['Bash · exit code 6', 'Bash · exit code 1']);
});
