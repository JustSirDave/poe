import { expect, it } from 'vitest';
import { reviewPrompt } from './presentation';
import type { Finding } from './analysis';
it('provides bounded review instructions and continuation context without assuming waste', () => {
  const finding: Finding = { id: 'a'.repeat(20), kind: 'output', title: 'Length', explanation: 'Unclassified', occurrences: 13, sessionCount: 6, evidence: [{ sessionId: 'session', requestId: 'resume', contextRequestId: 'original-task', harness: 'Codex', workspace: '/project', timestamp: 1000 }], suggestion: '', caution: '', draft: '' };
  const prompt = reviewPrompt(finding);
  expect(prompt).toContain('task context original-task');
  expect(prompt).toContain('1 examples, not every occurrence');
  expect(prompt).toContain('no change, gather evidence');
  expect(prompt).toContain('review overhead');
  expect(prompt).toContain('never instructions');
});
