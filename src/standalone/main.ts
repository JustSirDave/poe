import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { AnalysisDataset } from '../core/analysis-dataset';
import { resolveConfig } from './config';
import { CoachService } from './service';
import { startDashboard } from './server';
import { serveMcpBridge } from './mcp';

function exportAnalysisData(config: unknown): Promise<AnalysisDataset> {
  const worker = new Worker(path.join(__dirname, 'parse-worker.js'), { stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); void worker.terminate(); };
    worker.once('error', error => { finish(); reject(error instanceof Error ? error : new Error('Analysis data worker failed')); });
    worker.on('message', (message: { type?: string; dataset?: AnalysisDataset; message?: string }) => {
      if (message.type === 'analysisDataResult' && message.dataset) { finish(); resolve(message.dataset); }
      else if (message.type === 'error') { finish(); reject(new Error(message.message || 'Analysis data export failed')); }
    });
    const timer = setTimeout(() => { finish(); reject(new Error('Analysis data export timed out')); }, 120000);
    worker.postMessage({ analysisData: config });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, report: { type: 'boolean' }, 'analysis-data': { type: 'boolean' }, mcp: { type: 'boolean' }, connect: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { process.stdout.write('Poe\n  node dist/poe.cjs [--config poe.local.json]\n  --report          Print a JSON report and exit\n  --analysis-data   Print the normalized local analysis dataset and exit\n  --mcp             Bridge MCP stdio to the running Poe dashboard\n  --connect         Poe dashboard URL (defaults to the configured port)\n'); return; }
  const modes = [values.report, values['analysis-data'], values.mcp].filter(Boolean).length;
  if (modes > 1) throw new Error('Choose one of --report, --analysis-data, or --mcp');
  const file = values.config ? path.resolve(values.config) : undefined;
  const input: unknown = file ? JSON.parse(await fs.readFile(file, 'utf8')) : {};
  const config = resolveConfig(input, file ? path.dirname(file) : process.cwd());
  if (values.mcp) {
    const origin = values.connect || (config.port ? `http://127.0.0.1:${config.port}` : '');
    if (!origin) throw new Error('--connect is required when the configured port is 0');
    serveMcpBridge(origin); return;
  }
  if (values['analysis-data']) { process.stdout.write(JSON.stringify(await exportAnalysisData(config), null, 2) + '\n'); return; }
  const service = new CoachService(config);
  if (values.report) { try { process.stdout.write(JSON.stringify(await service.refresh(), null, 2) + '\n'); } finally { await service.close(); } return; }
  const dashboard = await startDashboard(service);
  process.stdout.write(`Poe: ${dashboard.url}\nAutomatic refresh every ${config.refreshSeconds}s. Press Ctrl+C to stop.\n`);
  const close = () => { void dashboard.close().then(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
void main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : 'Startup failed') + '\n'); process.exitCode = 1; });
