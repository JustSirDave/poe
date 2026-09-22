import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRequest, createSession } from '../core/parser-shared';
import { analyzeEfficiency } from './analysis';
import { resolveConfig } from './config';
import { createMcpHandler } from './mcp';
import { ReviewStore, type ReviewEvent } from './reviews';
import { CoachService } from './service';

// node:os's named exports can't be spied on directly under Vitest's ESM module handling
// ("Cannot redefine property"), so the mocked home directory is threaded through a mutable
// ref that the mock factory reads at call time.
const homedirRef = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homedirRef.value || actual.homedir() };
});

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
      const result = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'poe_findings' } }) as { result: { content: { text: string }[] } };
      return JSON.parse(result.result.content[0].text) as unknown[];
    }
    expect(await findings()).toHaveLength(0);
    await store.record({ id, action: 'reopened', at: new Date().toISOString() });
    expect(await findings()).toHaveLength(1);
    await expect(store.record({ id, action: 'dismissed', reason: 'invented', at: '' })).rejects.toThrow();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('migrates review history from the legacy ~/.ai-engineer-coach state directory once', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'poe-home-'));
  homedirRef.value = home;
  try {
    const legacyDir = path.join(home, '.ai-engineer-coach', 'standalone');
    await fs.mkdir(legacyDir, { recursive: true });
    const event = { id: 'a'.repeat(20), action: 'dismissed' as const, reason: 'incorrect' as const, at: new Date().toISOString() };
    await fs.writeFile(path.join(legacyDir, 'reviews.json'), JSON.stringify([event]));

    // config.ts's own stateDir default is computed once at import time from the real home
    // directory, so it can't pick up the mocked homedir() here; build the path the same way
    // resolveConfig's default would, so this exercises ReviewStore's migration against the
    // exact path a real upgrading user's default stateDir would resolve to.
    const config = resolveConfig({ stateDir: path.join(home, '.poe', 'standalone') }, home);
    const store = new ReviewStore(config.stateDir);
    await store.load();
    expect(store.history()).toEqual([event]);

    const migrated = JSON.parse(await fs.readFile(path.join(config.stateDir, 'reviews.json'), 'utf8')) as ReviewEvent[];
    expect(migrated).toEqual([event]);
  } finally { homedirRef.value = ''; await fs.rm(home, { recursive: true, force: true }); }
});
