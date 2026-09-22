/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const SESSION_PULL_REQUESTS_QUERY = `
SELECT DISTINCT
  session_id AS sessionId,
  ref_value AS refValue
FROM session_refs
WHERE ref_type = 'pr'`;

export const SESSION_MERGE_EVIDENCE_QUERY = `
SELECT
  turns.session_id AS sessionId,
  turns.assistant_response AS response
FROM turns
WHERE turns.assistant_response LIKE '%merged%'
  AND EXISTS (
    SELECT 1
    FROM session_refs AS refs
    WHERE refs.session_id = turns.session_id
      AND refs.ref_type = 'pr'
  )`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPullRequestReference(value: unknown): value is {
  sessionId: string;
  refValue: string;
} {
  if (!isRecord(value)) return false;
  return sessionId(value.sessionId) !== null
    && typeof value.refValue === 'string'
    && /^[1-9]\d*$/.test(value.refValue.trim());
}

// Reported-fact merge phrasing ("has been merged", "was merged successfully", ...).
// Deliberately excludes the "merged pull request" structured marker, checked separately
// against the full response since it's a low-false-positive tool-output-style line.
const MERGE_FACT_PATTERN = /\b(?:has been|was|is)\s+merged\b|\bsuccessfully\s+merged\b|\bmerged\s+successfully\b|\b(?:state|status)\s*[:=]\s*["']?merged\b/i;
// Words that turn "is merged" into a hypothetical/future statement rather than reported
// fact ("Once this PR is merged, CI will re-run" / "I'll let you know once it is merged").
const HYPOTHETICAL_MERGE_CONTEXT = /\b(?:once|when|after|if|before|will|would|should|let (?:you|me) know|going to|about to|need(?:s)? to)\b/i;

function hasMergeEvidence(response: unknown): boolean {
  if (typeof response !== 'string') return false;
  if (/^\s*merged pull request\b/im.test(response)) return true;
  if (!MERGE_FACT_PATTERN.test(response)) return false;
  // Scope the hypothetical-context check to the sentence containing the match, so an
  // unrelated hypothetical clause elsewhere in a long response can't suppress genuine
  // merge evidence, and vice versa.
  return response
    .split(/(?<=[.!?])\s+|\n+/)
    .some(sentence => MERGE_FACT_PATTERN.test(sentence) && !HYPOTHETICAL_MERGE_CONTEXT.test(sentence));
}

export function collectGitHubAppPullRequestSessionIds(
  values: readonly unknown[],
): Set<string> {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (isPullRequestReference(value)) sessionIds.add(value.sessionId);
  }
  return sessionIds;
}

export function collectGitHubAppMergedPullRequestSessionIds(
  values: readonly unknown[],
): Set<string> {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !hasMergeEvidence(value.response)) continue;
    const id = sessionId(value.sessionId);
    if (id) sessionIds.add(id);
  }
  return sessionIds;
}
