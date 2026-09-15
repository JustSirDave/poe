import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { ReviewStore } from './reviews';
import { CoachService } from './service';
import { resolveConfig } from './config';
import { analyzeEfficiency } from './analysis';
import { createRequest, createSession } from '../core/parser-shared';
import { createMcpHandler } from './mcp';

it('persists feedback and honors dismissal and reopening across MCP requests', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-feedback-'));
  try {
    const config = resolveConfig({ stateDir: directory }, directory);
    const service = new CoachService(config);
    const sessions = ['a', 'b', 'c'].map(id => createSession({ sessionId: id, workspaceId: 'p', workspaceName: 'p', harness: 'Codex', requests: [createRequest({ requestId: id, timestamp: Date.now() - 1000, messageText: 'Check the failing tests, explain the cause, implement the correction and verify the affected behavior.', responseText: '' })] }));
    service.report = analyzeEfficiency(sessions, config);
    const id = service.report.findings[0].id;
    const store = new ReviewStore(directory);
    await store.record({ id, action: 'dismissed', reason: 'incorrect', at: new Date().toISOString() });
    const reloaded = new ReviewStore(directory);
    await reloaded.load();
    expect(reloaded.history()[0].reason).toBe('incorrect');
    const handle = createMcpHandler(service);
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    async function findings() {
      const result = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'coach_findings' } }) as { result: { content: { text: string }[] } };
      return JSON.parse(result.result.content[0].text) as unknown[];
    }
    expect(await findings()).toHaveLength(0);
    await store.record({ id, action: 'reopened', at: new Date().toISOString() });
    expect(await findings()).toHaveLength(1);
    await expect(store.record({ id, action: 'dismissed', reason: 'invented', at: '' })).rejects.toThrow();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
