import { createHash } from 'node:crypto';
import type { SessionAccumulator } from './session-accumulator';
import { isHarnessInjectedContext } from './helpers';
import { redactSecrets } from './redact-secrets';

export interface ToolActivity {
  id: string; name: string; signature: string; timestamp: number | null;
  status: 'pending' | 'completed' | 'failed'; outputHash?: string;
  read: boolean; polling: boolean; epoch: number; turn: number;
}
export interface ReasoningActivity {
  id: string; hash: string; timestamp: number | null; length: number; turn: number; excerpt?: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function serialized(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(serialized).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + serialized(v)).join(',') + '}';
  return JSON.stringify(value) ?? '';
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.entries(record(value))
    .filter(([key]) => ['text', 'thinking', 'summary', 'content'].includes(key))
    .flatMap(([, item]) => strings(item));
  return [];
}

/** Bounded metadata only: raw arguments/results are not retained; reasoning previews are opt-in. */
export function observeTools(parser: SessionAccumulator, harness: 'claude' | 'codex', includeExcerpts = false): SessionAccumulator {
  const calls = new Map<string, ToolActivity>();
  const reasoning: ReasoningActivity[] = [];
  const reasoningSeen = new Set<string>();
  let epoch = 0; let turn = 0; let dropped = 0; let reasoningDropped = 0; let lastUser = '';
  const user = (text: string, timestamp: number | null) => {
    if (!text.trim() || isHarnessInjectedContext(text)) return;
    const key = hash(text) + ':' + (timestamp ?? '');
    if (key !== lastUser) { turn++; lastUser = key; }
  };
  const thought = (value: unknown, timestamp: number | null) => {
    for (const text of strings(value).filter(item => item.trim())) {
      const digest = hash(text);
      const duplicate = `${digest}:${timestamp ?? ''}`;
      if (reasoningSeen.has(duplicate)) continue;
      reasoningSeen.add(duplicate);
      reasoning.push({ id: hash(`${digest}:${timestamp ?? reasoning.length}`).slice(0, 20), hash: digest, timestamp, length: text.length, turn,
        ...(includeExcerpts ? { excerpt: redactSecrets(text).slice(0, 240) } : {}) });
      if (reasoning.length > 2000) { reasoning.shift(); reasoningDropped++; }
    }
  };
  const call = (id: unknown, name: unknown, args: unknown, timestamp: number | null) => {
    if (typeof id !== 'string' || typeof name !== 'string' || calls.has(id)) return;
    let input = args;
    if (typeof args === 'string') { try { input = JSON.parse(args) as unknown; } catch { /* Custom tools may use plain text. */ } }
    const short = name.split('.').pop()!.toLowerCase();
    const read = ['read', 'read_file', 'readfile'].includes(short);
    const polling = /wait|sleep|poll|write_stdin|status/.test(short);
    if (!read) epoch++;
    calls.set(id, { id, name: name.slice(0, 100), signature: hash(name + ':' + serialized(input)), timestamp, status: 'pending', read, polling, epoch, turn });
    if (calls.size > 2000) { calls.delete(calls.keys().next().value!); dropped++; }
  };
  const result = (id: unknown, output: unknown, explicitError?: unknown) => {
    if (typeof id !== 'string') return;
    const item = calls.get(id); if (!item) return;
    let decoded = output;
    if (typeof output === 'string') { try { decoded = JSON.parse(output) as unknown; } catch { /* Plain tool output is also supported. */ } }
    const obj = record(decoded);
    const text = typeof output === 'string' ? output : serialized(output);
    const exit = typeof obj.exit_code === 'number' ? obj.exit_code : typeof obj.exitCode === 'number' ? obj.exitCode : undefined;
    const match = text.match(/(?:^|\n)Process exited with code (-?\d+)(?:\r?\n|$)/);
    item.status = explicitError === true || obj.isError === true || (exit !== undefined && exit !== 0) || (match && Number(match[1]) !== 0) ? 'failed' : 'completed';
    item.outputHash = hash(text);
  };
  return {
    append(line: string) {
      parser.append(line);
      let raw: Record<string, unknown>;
      try { raw = record(JSON.parse(line)); } catch { return; }
      const time = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : typeof raw.timestamp === 'number' ? raw.timestamp : NaN;
      const timestamp = Number.isFinite(time) ? time : null;
      if (harness === 'codex') {
        const p = record(raw.payload);
        if (raw.type !== 'response_item' && raw.type !== 'event_msg') return;
        if (p.type === 'user_message') user(typeof p.message === 'string' ? p.message : typeof p.text === 'string' ? p.text : '', timestamp);
        if (raw.type === 'response_item' && p.role === 'user') user(strings(p.content).join('\n'), timestamp);
        if (p.type === 'agent_reasoning') thought(p.text, timestamp);
        if (raw.type === 'response_item' && (p.channel === 'analysis' || p.type === 'reasoning')) thought(p.content ?? p.summary, timestamp);
        if (p.type === 'function_call' || p.type === 'custom_tool_call') call(p.call_id, p.name, p.arguments ?? p.input, timestamp);
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') result(p.call_id, p.output, p.is_error);
      } else {
        const content = record(raw.message).content;
        if (raw.type === 'user') user(typeof content === 'string' ? content : Array.isArray(content) ? content.map(item => record(item)).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n') : '', timestamp);
        if (!Array.isArray(content)) return;
        for (const value of content) {
          const block = record(value);
          if (raw.type === 'assistant' && block.type === 'thinking') thought(block.thinking ?? block.text, timestamp);
          if (raw.type === 'assistant' && block.type === 'tool_use') call(block.id, block.name, block.input, timestamp);
          if (raw.type === 'user' && block.type === 'tool_result') result(block.tool_use_id, block.content, block.is_error);
        }
      }
    },
    snapshot() {
      const session = parser.snapshot();
      return session ? { ...session, toolActivity: [...calls.values()].map(item => ({ ...item })), toolActivityDropped: dropped,
        reasoningActivity: reasoning.map(item => ({ ...item })), reasoningActivityDropped: reasoningDropped } : null;
    },
  };
}
