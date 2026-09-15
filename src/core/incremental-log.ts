import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { SessionAccumulator } from './session-accumulator';

const PROBE_BYTES = 4096;
/** In-memory cursor. Rebuilds on rotation, truncation, changed boundary bytes, or periodic validation. */
export class IncrementalLog {
  private parser: SessionAccumulator;
  private size = 0;
  private identity = '';
  private prefix = '';
  private suffix = '';
  private pending = Buffer.alloc(0);
  private noNewline = false;
  private appends = 0;
  constructor(private readonly create: () => SessionAccumulator) { this.parser = create(); }
  read(file: string): { session: ReturnType<SessionAccumulator['snapshot']>; bytesRead: number; incremental: boolean } {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytesRead = 0;
    const read = (start: number, count: number) => {
      const data = Buffer.alloc(count);
      const length = fs.readSync(fd, data, 0, count, start);
      bytesRead += length;
      return data.subarray(0, length);
    };
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('Not a regular log file');
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let incremental = this.size > 0 && identity === this.identity && stat.size > this.size && this.appends < 20;
      if (incremental) {
        incremental = hash(read(0, Math.min(this.size, PROBE_BYTES))) === this.prefix
          && hash(read(Math.max(0, this.size - PROBE_BYTES), Math.min(this.size, PROBE_BYTES))) === this.suffix;
        if (incremental && this.noNewline) incremental = read(this.size, 1)[0] === 10 || read(this.size, 1)[0] === 13;
      }
      if (!incremental) { this.parser = this.create(); this.size = 0; this.pending = Buffer.alloc(0); this.noNewline = false; this.appends = 0; }
      const end = stat.size;
      let position = this.size;
      while (position < end) {
        const chunk = read(position, Math.min(1024 * 1024, end - position));
        if (!chunk.length) throw new Error('Log changed during read');
        position += chunk.length;
        const data = Buffer.concat([this.pending, chunk]);
        let start = 0;
        for (let index = data.indexOf(10); index >= 0; index = data.indexOf(10, start)) {
          const line = data.subarray(start, index).toString('utf8');
          if (line.trim()) this.parser.append(line);
          start = index + 1;
        }
        this.pending = Buffer.from(data.subarray(start));
      }
      this.noNewline = false;
      if (this.pending.length) {
        const text = this.pending.toString('utf8');
        let complete = false;
        try { JSON.parse(text); complete = true; } catch { /* A partial record waits for the next append. */ }
        if (complete) { this.parser.append(text); this.pending = Buffer.alloc(0); this.noNewline = true; }
      }
      const after = fs.fstatSync(fd);
      if (after.size < end) throw new Error('Log truncated during read');
      this.size = end; this.identity = identity; this.appends++;
      this.prefix = hash(read(0, Math.min(end, PROBE_BYTES)));
      this.suffix = hash(read(Math.max(0, end - PROBE_BYTES), Math.min(end, PROBE_BYTES)));
      return { session: this.parser.snapshot(), bytesRead, incremental };
    } finally { fs.closeSync(fd); }
  }
}
