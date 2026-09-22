/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { collectGitHubAppMergedPullRequestSessionIds } from './github-app-pr-references';

describe('collectGitHubAppMergedPullRequestSessionIds', () => {
  it('counts a reported-fact merge statement as evidence', () => {
    const ids = collectGitHubAppMergedPullRequestSessionIds([
      { sessionId: 's1', response: 'The pull request has been merged successfully.' },
    ]);
    expect(ids.has('s1')).toBe(true);
  });

  it('does not count a hypothetical/future statement about merging as evidence', () => {
    const ids = collectGitHubAppMergedPullRequestSessionIds([
      { sessionId: 's1', response: 'Once this PR is merged, CI will re-run automatically.' },
      { sessionId: 's2', response: "I'll let you know once it is merged." },
    ]);
    expect(ids.size).toBe(0);
  });

  it('still counts genuine merge evidence elsewhere in a response containing an unrelated hypothetical sentence', () => {
    const ids = collectGitHubAppMergedPullRequestSessionIds([
      { sessionId: 's1', response: 'If tests fail I will investigate. The PR was merged. Once deployed, monitor logs.' },
    ]);
    expect(ids.has('s1')).toBe(true);
  });

  it('counts a structured "merged pull request" marker regardless of surrounding text', () => {
    const ids = collectGitHubAppMergedPullRequestSessionIds([
      { sessionId: 's1', response: 'Merged pull request #42 into main.' },
    ]);
    expect(ids.has('s1')).toBe(true);
  });
});
