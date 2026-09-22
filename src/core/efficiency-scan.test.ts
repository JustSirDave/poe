import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../standalone/config';
import { scanEfficiency } from './efficiency-scan';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-scan-')); roots.push(root);
  const logs = path.join(root, 'logs'); fs.mkdirSync(logs);
  const config = resolveConfig({ sources: { claude: { enabled: false }, codex: { roots: [logs] }, vscode: { enabled: false }, copilot: { enabled: false } } }, root);
  const file = path.join(logs, 'one.jsonl');
  const timestamp = new Date().toISOString();
  const lines = [{ type: 'session_meta', payload: { id: 'sample-session', cwd: root } }, { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Inspect the failing test and explain the reason it failed before making a focused fix.' } }];
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
  return { root, config, file, timestamp };
}
describe('standalone log scans', () => {
  it('reuses unchanged logs, parses appended active turns, and evicts deleted files', () => {
    const { config, file, timestamp } = setup();
    expect(scanEfficiency(config).scan.parsed).toBe(1);
    expect(scanEfficiency(config).scan.reused).toBe(1);
    fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Now test the changed behavior again.' } }));
    const updated = scanEfficiency(config); expect(updated.scan.parsed).toBe(1); expect(updated.requestCount).toBe(2);
    fs.unlinkSync(file); expect(scanEfficiency(config).requestCount).toBe(0);
  });
  it('honors workspace boundaries and source switches', () => {
    const { config, root } = setup();
    expect(scanEfficiency({ ...config, workspaceRoots: [root + '-different'] }).requestCount).toBe(0);
    expect(scanEfficiency({ ...config, workspaceRoots: [root] }).requestCount).toBe(1);
    expect(scanEfficiency({ ...config, sources: { claude: { enabled: false, roots: [] }, codex: { enabled: false, roots: [] }, vscode: { enabled: false, roots: [] }, copilot: { enabled: false, roots: [] } } }).requestCount).toBe(0);
  });
  it('does not duplicate sessions copied into archives', () => {
    const { config, file } = setup(); fs.copyFileSync(file, path.join(path.dirname(file), 'archive.jsonl'));
    expect(scanEfficiency(config).sessionCount).toBe(1);
  });
  it('reports missing sources and malformed files', () => {
    const { config, file, root } = setup(); fs.writeFileSync(file, 'not json');
    const report = scanEfficiency({ ...config, sources: { ...config.sources, claude: { enabled: true, roots: [path.join(root, 'missing')] } } });
    expect(report.scan.skipped).toBe(1); expect(report.sources.some(source => !source.exists)).toBe(true);
  });
  it('loads GitHub Copilot CLI events through the standalone source adapter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-copilot-')); roots.push(root);
    const source = path.join(root, 'session-state'); const sessionDir = path.join(source, 'session-one'); fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'name: copilot-project\n');
    const timestamp = new Date().toISOString();
    const events = [
      { type: 'session.start', timestamp, data: { sessionId: 'copilot-session', startTime: timestamp, selectedModel: 'gpt-5' } },
      { type: 'user.message', timestamp, data: { content: 'Inspect the current implementation and report the result.' } },
      { type: 'assistant.message', id: 'answer', timestamp, data: { content: 'Done.', outputTokens: 12 } },
      { type: 'session.shutdown', timestamp, data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 100, outputTokens: 12 } } } } },
    ];
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));
    const config = resolveConfig({ sources: { claude: { enabled: false }, codex: { enabled: false }, vscode: { enabled: false }, copilot: { roots: [source] } } }, root);
    const report = scanEfficiency(config);
    expect(report.usageHistory.byHarness['GitHub Copilot CLI']).toMatchObject({ sessions: 1, turns: 1, output: 12 });
    expect(report.sources).toContainEqual({ harness: 'copilot', root: source, exists: true });
  });
});
