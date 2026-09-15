import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfig } from './config';
import { CoachService } from './service';
import { startDashboard } from './server';
import { serveMcpBridge } from './mcp';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, report: { type: 'boolean' }, mcp: { type: 'boolean' }, connect: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { process.stdout.write('Poe\n  node dist/poe.cjs [--config poe.local.json]\n  --report   Print a JSON report and exit\n  --mcp      Bridge MCP stdio to the running Poe dashboard\n  --connect  Poe dashboard URL (defaults to the configured port)\n'); return; }
  if (values.report && values.mcp) throw new Error('Choose either --report or --mcp');
  const file = values.config ? path.resolve(values.config) : undefined;
  const input: unknown = file ? JSON.parse(await fs.readFile(file, 'utf8')) : {};
  const config = resolveConfig(input, file ? path.dirname(file) : process.cwd());
  if (values.mcp) {
    const origin = values.connect || (config.port ? `http://127.0.0.1:${config.port}` : '');
    if (!origin) throw new Error('--connect is required when the configured port is 0');
    serveMcpBridge(origin); return;
  }
  const service = new CoachService(config);
  if (values.report) { try { process.stdout.write(JSON.stringify(await service.refresh(), null, 2) + '\n'); } finally { await service.close(); } return; }
  const dashboard = await startDashboard(service);
  process.stdout.write(`Poe: ${dashboard.url}\nAutomatic refresh every ${config.refreshSeconds}s. Press Ctrl+C to stop.\n`);
  const close = () => { void dashboard.close().then(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
void main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : 'Startup failed') + '\n'); process.exitCode = 1; });
