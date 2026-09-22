/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { NANO_AIU_PER_AI_CREDIT, aggregateGitHubAppIssueCredits } from './github-app-issue-credit-model';

describe('aggregateGitHubAppIssueCredits', () => {
  it('splits a session linked to multiple issues evenly, so per-issue estimates sum to the deduped total', () => {
    const totalNanoAiu = 5 * NANO_AIU_PER_AI_CREDIT;
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [
        { workspaceId: 'w1', repository: 'org/repo', issueNumber: 10 },
        { workspaceId: 'w1', repository: 'org/repo', issueNumber: 11 },
      ],
      workspaceSessions: [{ workspaceId: 'w1', sessionId: 's1' }],
      sessionIssues: [],
      sessionUsage: [{ sessionId: 's1', totalNanoAiu }],
    });

    expect(metrics.issues).toHaveLength(2);
    expect(metrics.issues[0].estimatedCredits).toBeCloseTo(2.5);
    expect(metrics.issues[1].estimatedCredits).toBeCloseTo(2.5);
    const perIssueSum = metrics.issues.reduce((sum, issue) => sum + issue.estimatedCredits, 0);
    expect(perIssueSum).toBeCloseTo(metrics.estimatedCredits);
    expect(metrics.estimatedCredits).toBeCloseTo(5);
  });

  it('credits a session linked to only one issue in full', () => {
    const totalNanoAiu = 3 * NANO_AIU_PER_AI_CREDIT;
    const metrics = aggregateGitHubAppIssueCredits({
      workspaceIssues: [{ workspaceId: 'w1', repository: 'org/repo', issueNumber: 10 }],
      workspaceSessions: [{ workspaceId: 'w1', sessionId: 's1' }],
      sessionIssues: [],
      sessionUsage: [{ sessionId: 's1', totalNanoAiu }],
    });

    expect(metrics.issues).toHaveLength(1);
    expect(metrics.issues[0].estimatedCredits).toBeCloseTo(3);
  });
});
