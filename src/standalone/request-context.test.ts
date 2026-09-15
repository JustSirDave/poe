import { describe, expect, it } from 'vitest';
import { createRequest, createSession } from '../core/parser-shared';
import { responseContexts } from './request-context';
import { analyzeEfficiency } from './analysis';
import { resolveConfig } from './config';
const now = Date.now();
function turn(id: string, messageText: string) { return createRequest({ requestId: id, timestamp: now - 1000, messageText, responseText: '', longestAssistantMessage: 14000 }); }
describe('request-aware response review', () => {
  it('inherits explicit audit intent through consecutive resume messages', () => {
    const turns = [turn('audit', 'I want you to audit the CI/CD pipeline and give me a clinical report'), turn('resume', 'resume what you were doing'), turn('again', 'continue')];
    const contexts = responseContexts(turns);
    expect(contexts.get('again')).toEqual({ intent: 'requested-detail', requestId: 'audit' });
    const report = analyzeEfficiency([createSession({ sessionId: 's', workspaceId: 'p', workspaceName: 'p', harness: 'Codex', requests: turns })], resolveConfig({}, process.cwd()), now);
    expect(report.responseReview?.requestedDetail).toBe(3);
    expect(report.findings).toEqual([]);
  });
  it('resets context for a new task and does not call ambiguous length waste', () => {
    const contexts = responseContexts([turn('audit', 'Write a detailed report.'), turn('new', 'Fix the button.'), turn('resume', 'continue')]);
    expect(contexts.get('resume')).toEqual({ intent: 'unclassified', requestId: 'new' });
    expect(responseContexts([turn('alone', 'resume what you were doing')]).get('alone')?.intent).toBe('unclassified');
  });
  it('preserves explicit brevity and rejects negated detail or quoted annotations', () => {
    expect(responseContexts([turn('short', 'Write a report but keep it brief.')]).get('short')?.intent).toBe('brevity-conflict');
    expect(responseContexts([turn('no', "Do not write a detailed report. Fix the issue.")]).get('no')?.intent).toBe('unclassified');
    expect(responseContexts([turn('annotation', 'Write a detailed report. ## My request: Fix the label.')]).get('annotation')?.intent).toBe('unclassified');
  });
});
