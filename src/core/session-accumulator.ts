/** Streaming contract used by the standalone observer; snapshots must not finalize live state. */
export interface SessionAccumulator {
  append(line: string): void;
  snapshot(): import('./types').Session | null;
}
