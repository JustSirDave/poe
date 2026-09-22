import { describe, expect, it } from 'vitest';
import { buildAnalysisDataset } from './analysis-dataset';
import { createRequest, createSession } from './parser-shared';

describe('analysis dataset', () => {
  it('exports stable evidence metadata without transcript text by default', () => {
    const request = createRequest({
      requestId: 'r1',
      timestamp: 1000,
      messageText: 'Fix the failing test with token sk-' + 'a'.repeat(45),
      responseText: 'Implemented the fix.',
      promptTokens: 120,
      completionTokens: 30,
    });
    const session = createSession({
      sessionId: 's1', workspaceId: 'w1', workspaceName: 'Project', harness: 'Codex', requests: [request],
      toolActivity: [{ id: 't1', name: 'exec', signature: 'sig', timestamp: 1100, status: 'failed', outputHash: 'out', failureCategory: 'test failure', exitCode: 1, read: false, polling: false, epoch: 1, turn: 1 }],
      reasoningActivity: [{ id: 'q1', hash: 'thought', timestamp: 1050, length: 40, turn: 1, excerpt: 'private reasoning preview' }],
      toolActivityDropped: 2,
      reasoningActivityDropped: 3,
    });

    const dataset = buildAnalysisDataset([session], { now: 2000 });

    expect(dataset.schemaVersion).toBe(1);
    expect(dataset.contentMode).toBe('metadata');
    expect(dataset.turns[0].tokens.inputScope).toBe('turn-delta');
    expect(dataset.coverage).toMatchObject({ sessions: 1, turns: 1, turnsWithInput: 1, toolEventsRetained: 1, toolEventsDropped: 2, reasoningEventsRetained: 1, reasoningEventsDropped: 3 });
    expect(JSON.stringify(dataset)).not.toContain('Fix the failing test');
    expect(JSON.stringify(dataset)).not.toContain('private reasoning preview');
    expect(dataset.toolEvents[0].failureCategory).toBe('test failure');
  });

  it('labels source-specific counter scopes and redacts opted-in previews', () => {
    const secret = 'sk-' + 'b'.repeat(45);
    const sources = [
      ['Claude', 'turn-aggregate', 'turn-aggregate'],
      ['VS Code Copilot', 'last-agentic-round', 'turn-aggregate'],
      ['GitHub Copilot CLI', 'unavailable', 'turn-aggregate'],
      ['Other', 'unknown', 'unknown'],
    ] as const;
    const sessions = sources.map(([harness], index) => createSession({
      sessionId: `s${index}`, workspaceId: 'w', workspaceName: 'Project', harness,
      requests: [createRequest({ requestId: `r${index}`, messageText: `Use ${secret}`, responseText: 'Done' })],
    }));

    const dataset = buildAnalysisDataset(sessions, { includePreviews: true, now: 2000 });

    expect(dataset.contentMode).toBe('preview');
    for (const [index, [, inputScope, outputScope]] of sources.entries()) {
      expect(dataset.turns[index].tokens).toMatchObject({ inputScope, outputScope });
    }
    expect(dataset.turns[0].promptPreview).toContain('REDACTED');
    expect(JSON.stringify(dataset)).not.toContain(secret);
  });
});
