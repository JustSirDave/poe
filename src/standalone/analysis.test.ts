import { describe, expect, it } from 'vitest';
import { createRequest, createSession } from '../core/parser-shared';
import { analyzeEfficiency } from './analysis';
import { resolveConfig } from './config';
const now = Date.now();
const repeated = 'Inspect the failing tests, explain the root cause, implement a focused fix and rerun the affected tests.';
function session(id: string, message = repeated, workspace = '/project') {
  return createSession({ sessionId: id, workspaceId: workspace, workspaceName: workspace, workspaceRootPath: workspace, harness: 'Codex', requests: [createRequest({ requestId: id + '-r', timestamp: now - 1000, messageText: message, responseText: 'Done' })] });
}
const config = resolveConfig({}, process.cwd());
describe('efficiency candidates', () => {
  it('groups exact instructions across sessions without exposing prompt text by default', () => {
    const report = analyzeEfficiency([session('a'), session('b'), session('c')], config, now);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].occurrences).toBe(3);
    expect(JSON.stringify(report)).not.toContain(repeated);
    expect(report.recordedTokens.turnsWithInput).toBe(0);
  });
  it('does not merge different constraints or unrelated workspaces', () => {
    expect(analyzeEfficiency([session('a'), session('b', repeated + ' Do not change public APIs.'), session('c', repeated, '/other')], config, now).findings).toHaveLength(0);
  });
  it('requires multiple sessions and excludes old or missing timestamps', () => {
    const a = session('same'); a.requests.push(...session('same').requests, ...session('same').requests);
    expect(analyzeEfficiency([a], config, now).findings).toHaveLength(0);
    a.requests[0].timestamp = null; a.requests[1].timestamp = now - 40 * 86400000;
    expect(analyzeEfficiency([a], config, now).requestCount).toBe(1);
  });
  it('redacts optional evidence before returning it', () => {
    const message = repeated + ' api_key="sk-' + 'a'.repeat(45) + '"';
    const report = analyzeEfficiency([session('a', message), session('b', message), session('c', message)], { ...config, includeExcerpts: true }, now);
    expect(report.findings[0].evidence[0].excerpt).toContain('REDACTED');
    expect(JSON.stringify(report)).not.toContain('a'.repeat(45));
  });
  it('records known zero token usage and flags response size without claiming savings', () => {
    const sessions = ['a', 'b', 'c'].map(id => session(id, 'hello'));
    for (const s of sessions) { s.requests[0].promptTokens = 0; s.requests[0].completionTokens = 100; s.requests[0].responseLength = 15000; s.requests[0].longestAssistantMessage = 15000; }
    const report = analyzeEfficiency(sessions, config, now);
    expect(report.recordedTokens).toEqual({ input: 0, output: 300, cacheRead: 0, cacheWrite: 0, turnsWithInput: 3, turnsWithOutput: 3 });
    expect(report.findings[0].kind).toBe('output');
    expect(report.findings[0].caution).toContain('not measured token waste');
  });
  it('breaks out cache read/write tokens separately from the blended input total', () => {
    const s = session('a', 'hello');
    s.requests[0].promptTokens = 2000; s.requests[0].cacheReadTokens = 1800; s.requests[0].cacheWriteTokens = 150;
    const report = analyzeEfficiency([s], config, now);
    expect(report.recordedTokens).toMatchObject({ input: 2000, cacheRead: 1800, cacheWrite: 150 });
  });
  it('rejects unknown config fields and dangerous resource settings', () => {
    expect(() => resolveConfig({ refreshSeconds: 0 }, process.cwd())).toThrow();
    expect(() => resolveConfig({ maxFiles: 1000000 }, process.cwd())).toThrow();
    expect(() => resolveConfig({ includeExcerpt: true }, process.cwd())).toThrow();
  });
});

it('samples recent distinct sessions instead of the first three matching turns', () => {
  const older = session('old'); older.requests[0].timestamp = now - 5000;
  older.requests.push({ ...older.requests[0], requestId: 'old-2' }, { ...older.requests[0], requestId: 'old-3' });
  const newer = session('new'); newer.requests[0].timestamp = now - 100;
  const middle = session('middle'); middle.requests[0].timestamp = now - 1000;
  const finding = analyzeEfficiency([older, newer, middle], config, now).findings[0];
  expect(finding.evidence.map(item => item.sessionId)).toEqual(['new', 'middle', 'old']);
  expect(finding.occurrences).toBe(5);
  expect(finding.firstSeen).toBe(now - 5000);
  expect(finding.lastSeen).toBe(now - 100);
});

it('requires enough current evidence even when a wider history window is configured', () => {
  const sessions = ['old-a', 'old-b', 'current'].map(id => session(id));
  sessions[0].requests[0].timestamp = now - 22 * 86400000;
  sessions[1].requests[0].timestamp = now - 6 * 86400000;
  const report = analyzeEfficiency(sessions, { ...config, lookbackDays: 30 }, now);
  expect(report.activeWindowDays).toBe(5);
  expect(report.requestCount).toBe(1);
  expect(report.findings).toEqual([]);
  sessions[0].requests[0].timestamp = now - 5 * 86400000;
  sessions[1].requests[0].timestamp = now - 3600000;
  expect(analyzeEfficiency(sessions, config, now).findings[0].occurrences).toBe(3);
  expect(analyzeEfficiency(sessions, config, now + 1).findings).toEqual([]);
});

describe('usageBreakdown', () => {
  it('groups requests by normalized model id and estimates cost only for known models', () => {
    const a = session('a', 'hello'); a.requests[0].modelId = 'claude-sonnet-4-5-20250514'; a.requests[0].promptTokens = 1_000_000; a.requests[0].completionTokens = 1_000_000;
    const b = session('b', 'hi'); b.requests[0].modelId = 'some-unreleased-model'; b.requests[0].promptTokens = 500;
    const report = analyzeEfficiency([a, b], config, now);
    expect(report.usageBreakdown.models).toHaveLength(2);
    const known = report.usageBreakdown.models.find(m => m.modelId === 'claude-sonnet-4.5')!;
    expect(known.turns).toBe(1);
    expect(known.estimatedCostUsd).toBeCloseTo(18.0, 5);
    const unknown = report.usageBreakdown.models.find(m => m.label === 'some-unreleased-model')!;
    expect(unknown.estimatedCostUsd).toBeNull();
    expect(report.usageBreakdown.hasUnknownModelCost).toBe(true);
    expect(report.usageBreakdown.estimatedCostUsd).toBeCloseTo(18.0, 5);
  });

  it('groups MCP tool calls by server name split on the double-underscore delimiter', () => {
    const s = session('a', 'hello');
    s.requests[0].toolsUsed = ['mcp__Claude_Browser__computer', 'mcp__Claude_Browser__navigate', 'Read', 'Read'];
    const report = analyzeEfficiency([s], config, now);
    const sources = new Map(report.usageBreakdown.toolSources.map(t => [t.source, t]));
    expect(sources.get('Claude_Browser')).toMatchObject({ kind: 'mcp', calls: 2 });
    expect(sources.get('Read')).toMatchObject({ kind: 'tool', calls: 2 });
  });

  it('computes cache hit rate from cache-read share of total input', () => {
    const s = session('a', 'hello');
    s.requests[0].modelId = 'claude-sonnet-4.5'; s.requests[0].promptTokens = 1000; s.requests[0].cacheReadTokens = 800;
    const report = analyzeEfficiency([s], config, now);
    expect(report.usageBreakdown.cacheHitRate).toBeCloseTo(0.8, 5);
  });

  it('reports no LOC data when no editLocIndex is supplied', () => {
    const s = session('a', 'hello');
    const report = analyzeEfficiency([s], config, now);
    expect(report.usageBreakdown.hasLocData).toBe(false);
    expect(report.usageBreakdown.linesAdded).toBe(0);
  });

  it('sums added/removed lines from the editLocIndex for requests in the active window', () => {
    const s = session('a', 'hello');
    const editLocIndex = new Map([[s.requests[0].requestId, new Map([['file:///a.ts', { added: 12, removed: 4 }]])]]);
    const report = analyzeEfficiency([s], config, now, editLocIndex);
    expect(report.usageBreakdown.hasLocData).toBe(true);
    expect(report.usageBreakdown.linesAdded).toBe(12);
    expect(report.usageBreakdown.linesRemoved).toBe(4);
  });
});

it('keeps historical usage separate from the five-day coaching window', () => {
  const recent = session('recent');
  recent.requests[0].promptTokens = 120;
  recent.requests[0].completionTokens = 30;
  const older = session('older');
  older.harness = 'Claude';
  older.requests[0].timestamp = now - 30 * 86400000;
  older.requests[0].promptTokens = 400;
  older.requests[0].completionTokens = 80;
  older.requests[0].cacheReadTokens = 300;
  older.requests[0].cacheWriteTokens = 20;
  const report = analyzeEfficiency([recent, older], config, now);
  expect(report.requestCount).toBe(1);
  expect(report.usageHistory.byHarness.Claude).toMatchObject({ sessions: 1, turns: 1, input: 400, output: 80, cacheRead: 300, cacheWrite: 20 });
  expect(report.usageHistory.byHarness.Codex).toMatchObject({ sessions: 1, turns: 1, input: 120, output: 30 });
  // Reused Session objects (an unchanged log file on the next refresh) should reuse cached
  // per-session usage rather than double-count it on a repeat call with the same references.
  const again = analyzeEfficiency([recent, older], config, now);
  expect(again.usageHistory.byHarness.Claude).toMatchObject({ sessions: 1, turns: 1, input: 400, output: 80, cacheRead: 300, cacheWrite: 20 });
  expect(again.usageHistory.byHarness.Codex).toMatchObject({ sessions: 1, turns: 1, input: 120, output: 30 });
  expect(again.usageHistory.days).toEqual(report.usageHistory.days);
  expect(report.usageHistory.days).toHaveLength(2);
  const date = new Date(now - 30 * 86400000); const pad = (value: number) => String(value).padStart(2, '0');
  expect(report.usageHistory.days[0].date).toBe(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
});
