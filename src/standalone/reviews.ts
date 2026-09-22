import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const eventSchema = z.object({ id: z.string().regex(/^[a-f0-9]{20}$/), action: z.enum(['dismissed', 'reopened']), reason: z.enum(['useful', 'expected', 'incorrect', 'not-now']).optional(), at: z.string() });
const historySchema = z.array(eventSchema).max(2000);
export type ReviewEvent = z.infer<typeof eventSchema>;

// Poe's default state directory moved from ~/.ai-engineer-coach/standalone to ~/.poe/standalone.
// Adopt any history left at the old location once, so upgrading does not silently reopen every
// previously dismissed finding for users who never set an explicit stateDir. Resolved lazily (not
// as a module-level constant) so it reflects the home directory at load time, not at import time.
const legacyDefaultFile = () => path.join(os.homedir(), '.ai-engineer-coach', 'standalone', 'reviews.json');
const currentDefaultFile = () => path.join(os.homedir(), '.poe', 'standalone', 'reviews.json');

export class ReviewStore {
  private events: ReviewEvent[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    const file = path.join(this.directory, 'reviews.json');
    try { this.events = historySchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Review history could not be read; restore or move reviews.json before starting.', { cause: error }); }
    if (path.resolve(file) !== path.resolve(currentDefaultFile())) return;
    try {
      this.events = historySchema.parse(JSON.parse(await fs.readFile(legacyDefaultFile(), 'utf8')));
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, JSON.stringify(this.events), { mode: 0o600 });
    } catch { /* No legacy history to migrate. */ }
  }
  history(): ReviewEvent[] { return [...this.events]; }
  async record(input: unknown): Promise<void> {
    const event = eventSchema.parse(input);
    const write = this.queue.then(async () => {
      const next = [...this.events, event].slice(-2000);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = path.join(this.directory, 'reviews.json.tmp');
      await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temp, path.join(this.directory, 'reviews.json'));
      this.events = next;
    });
    this.queue = write.catch(() => {});
    return write;
  }
}
