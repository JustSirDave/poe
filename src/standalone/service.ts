import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CoachConfig } from './config';
import type { CoachReport } from './analysis';

export class CoachService {
  private worker?: Worker;
  private pending?: Promise<CoachReport>;
  private rejectPending?: (error: Error) => void;
  report?: CoachReport;
  error?: string;
  constructor(readonly config: CoachConfig) {}

  refresh(): Promise<CoachReport> {
    if (this.pending) return this.pending;
    this.pending = this.scan().then(report => { this.report = report; this.error = undefined; return report; })
      .catch((error: unknown) => { this.error = error instanceof Error ? error.message : 'Scan failed'; throw error; })
      .finally(() => { this.pending = undefined; this.rejectPending = undefined; });
    return this.pending;
  }

  private scan(): Promise<CoachReport> {
    if (!this.worker) {
      this.worker = new Worker(path.join(__dirname, 'parse-worker.js'), { stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
      // Parser diagnostics must never leak onto MCP stdout or copy transcript text to logs.
      this.worker.stdout.resume(); this.worker.stderr.resume();
      const created = this.worker;
      this.worker.on('error', error => { if (this.worker !== created) return; this.rejectPending?.(error instanceof Error ? error : new Error('Worker failed')); this.worker = undefined; });
      this.worker.on('exit', () => { if (this.worker !== created) return; this.rejectPending?.(new Error('Analysis worker stopped')); this.worker = undefined; });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); worker.off('message', receive); };
      const fail = (error: Error) => { finish(); reject(error); };
      const receive = (message: { type: string; report?: CoachReport; message?: string }) => {
        if (message.type === 'efficiencyResult' && message.report) { finish(); resolve(message.report); }
        else if (message.type === 'error') fail(new Error(message.message || 'Scan failed'));
      };
      const timer = setTimeout(() => { this.worker = undefined; fail(new Error('Scan timed out; narrow source roots or reduce maxFiles')); void worker.terminate(); }, 120000);
      this.rejectPending = fail;
      worker.on('message', receive);
      worker.postMessage({ efficiency: this.config });
    });
  }

  async close(): Promise<void> {
    this.rejectPending?.(new Error('Service closed'));
    if (this.worker) { const worker = this.worker; this.worker = undefined; await worker.terminate(); }
  }
}
