import { createHash } from 'node:crypto';
import type { SessionAccumulator } from './session-accumulator';

export interface ToolActivity {
  id: string; name: string; signature: string; timestamp: number | null;
  status: 'pending' | 'completed' | 'failed'; outputHash?: string;
  read: boolean; polling: boolean; epoch: number;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function serialized(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(serialized).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + serialized(v)).join(',') + '}';
  return JSON.stringify(value) ?? '';
}
/** Bounded metadata only: raw arguments and results are never retained. */
export function observeTools(parser: SessionAccumulator, harness: 'claude' | 'codex'): SessionAccumulator {
  const calls = new Map<string, ToolActivity>();
  let epoch = 0; let dropped = 0;
  const call = (id: unknown, name: unknown, args: unknown, timestamp: number | null) => {
    if (typeof id !== 'string' || typeof name !== 'string' || calls.has(id)) return;
    let input = args;
    if (typeof args === 'string') { try { input = JSON.parse(args) as unknown; } catch { /* Custom tools may use plain text. */ } }
    const short = name.split('.').pop()!.toLowerCase();
    const read = ['read', 'read_file', 'readfile'].includes(short);
    const polling = /wait|sleep|poll|write_stdin|status/.test(short);
    if (!read) epoch++;
    calls.set(id, { id, name: name.slice(0, 100), signature: hash(name + ':' + serialized(input)), timestamp, status: 'pending', read, polling, epoch });
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
        if (p.type === 'function_call' || p.type === 'custom_tool_call') call(p.call_id, p.name, p.arguments ?? p.input, timestamp);
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') result(p.call_id, p.output, p.is_error);
      } else {
        const content = record(raw.message).content;
        if (!Array.isArray(content)) return;
        for (const value of content) {
          const block = record(value);
          if (raw.type === 'assistant' && block.type === 'tool_use') call(block.id, block.name, block.input, timestamp);
          if (raw.type === 'user' && block.type === 'tool_result') result(block.tool_use_id, block.content, block.is_error);
        }
      }
    },
    snapshot() {
      const session = parser.snapshot();
      return session ? { ...session, toolActivity: [...calls.values()].map(item => ({ ...item })), toolActivityDropped: dropped } : null;
    },
  };
}
