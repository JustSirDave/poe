import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

const eventSchema = z.object({ id: z.string().regex(/^[a-f0-9]{20}$/), action: z.enum(['dismissed', 'reopened']), at: z.string() });
const historySchema = z.array(eventSchema).max(2000);
export type ReviewEvent = z.infer<typeof eventSchema>;

export class ReviewStore {
  private events: ReviewEvent[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    try { this.events = historySchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, 'reviews.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Review history could not be read; restore or move reviews.json before starting.', { cause: error }); }
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
