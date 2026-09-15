# Session Efficiency Coach — standalone edition

A local, automatically refreshing dashboard and read-only MCP integration for Claude Code and Codex. This fork retains Microsoft's original extension and MIT notices. The standalone edition reads session logs, not project documentation.

## Run

Use Node.js 24 LTS and npm. From this repository:

```sh
npm ci
npm run build:coach
npm run coach
```

Open the loopback URL printed in the terminal (normally `http://127.0.0.1:4317`). Keep the process running for automatic observation. This version does not install a startup service.

The standalone build has no VS Code requirement. The upstream extension remains available through its existing build commands.

## Using the dashboard

Overview summarizes observed sessions and recorded tokens. **Opportunities** are suggestions based on repeated patterns, not changes already applied or proven savings. Filter them by Skills, Memory, Workflows, or Response length.

Choose **Review idea** to see what was noticed, why it might help, what to try, and the session references. **Copy review prompt** prepares a request you can paste into Claude Code or Codex to evaluate the idea. Prompt excerpts remain controlled by your local configuration. **Dismiss idea** moves the decision to Review history, where you can reopen it.

Connected sources shows the session folders and observation limits. Navigation supports browser history, and the review panel supports keyboard navigation and Escape to close. The visual guidelines live in [the dashboard design system](design-system/session-coach/MASTER.md).

## Configure

Copy `coach.example.json` to `coach.local.json`, then run:

```sh
npm run coach -- --config coach.local.json
```

`coach.local.json` is ignored by Git. Empty source-root arrays use defaults:

- Claude: `<CLAUDE_CONFIG_DIR>/projects`, or `~/.claude/projects`.
- Codex: `<CODEX_HOME>/sessions`, `archived_sessions`, and `archived-sessions`, or the corresponding directories under `~/.codex`.

Set `enabled: false` to disable a source. Explicit roots must be directories containing session JSONL files, not your entire home or project directory. Relative paths resolve against the config file's directory. Symlink entries are skipped. On Windows, use forward slashes or escaped backslashes in JSON. Windows and WSL have separate home directories: configure the location where the sessions actually live.

`workspaceRoots` filters sessions by their recorded working directory after parsing logs; it is not a filesystem permission boundary. Unknown working directories are excluded when this filter is set. The coach never opens project documentation to apply this filter.

`lookbackDays` limits analyzed turns; discovery still inspects metadata and reads selected log files. `maxFiles` selects the most recently modified files, and `maxFileMB` skips oversized files. The dashboard reports skips. Unchanged files are reused in worker memory. Normally, growing files consume only appended bytes plus small boundary probes. Codex retains parser state; Claude retains completed turns and re-evaluates its unfinished turn as tool results arrive. Partial JSON and UTF-8 records wait for completion. Truncation, replacement, changed boundary bytes, and every twentieth append trigger a fresh parse. Boundary probes cannot detect every interior rewrite during growth; periodic revalidation limits that uncertainty. Cursors are in memory only, so restarting performs an initial scan. No raw transcript disk cache is created. Default refresh is 120 seconds.

## Prompt previews

Set `"includeExcerpts": true` in `coach.local.json`, then restart with `npm run coach -- --config coach.local.json`. Set it back to false and restart to hide previews. Excerpts are short; secret masking is best effort. Enabling this also includes excerpts in reports and MCP findings using that configuration. It does not make model calls.

## Measurement boundaries

Internal Codex guardian approval-review sessions are excluded from standalone coaching and its token/session totals. Connected sources reports the excluded count. Ordinary agent sessions remain eligible. Codex response-item-only logs are split at user messages; multipart user content is joined before comparison.

Response-length candidates require an individual conversational assistant message above the threshold. Recorded analysis and file-write payloads are excluded; unknown conversational lengths do not trigger candidates. Explicit requests for detailed reports/audits are counted separately rather than suggested for shortening. Consecutive resume messages inherit their last substantive request within the same session. A new task resets that context. Explicit brevity signals and unclassified messages remain separate review groups. These narrow local text rules do not establish semantic intent, repetition, correctness, or token waste. Task-context request IDs are included with evidence; no project documents are opened.

## What works today

- Exact repeated substantial instructions across sessions, scoped to the recorded workspace.
- Repeated instructions with preference language as possible memory candidates.
- Recurring recorded tool sequences as possible workflow candidates.
- Large recorded response signals, with explicit caveats.
- Input/output token fields and their turn coverage, when available.
- Evidence references, optional masked prompt excerpts, candidate checklists, and persistent dismiss/reopen history.
- Bounded read-only MCP tools and a one-shot JSON report.

The coach performs no model calls. It does not inspect hidden reasoning, reconstruct the complete model context, verify task success, measure token savings, or automatically install skills or memory. Candidate checklists are starting points for evaluation, not production-ready generated skills. Exact matching deliberately misses paraphrases instead of merging different constraints. Tool names alone are weak evidence; inspect the actual examples before automating.

Claude subagent log files are observed individually. Some harnesses reuse identifiers or emit overlapping records, so counts are observational rather than authoritative billing totals. Token interpretation follows the upstream parsers, which can change as log formats evolve. Cached input is not added again to input totals. Missing token fields remain unknown.

## Claude Code and Codex integration

Build first. Use an absolute path to `dist/coach.cjs` and, optionally, an absolute local config path. Do not launch MCP through `npm run`, which prints non-protocol text on stdout.

```sh
claude mcp add --transport stdio session-coach -- node /absolute/path/AI-Engineering-Coach/dist/coach.cjs --mcp --config /absolute/path/coach.local.json
codex mcp add session-coach -- node /absolute/path/AI-Engineering-Coach/dist/coach.cjs --mcp --config /absolute/path/coach.local.json
```

For Windows, substitute quoted absolute Windows paths. Available tools:

- `coach_summary`: small summary with observation limits.
- `coach_findings`: up to ten candidates; defaults to three.
- `coach_proposal`: one candidate checklist by ID.

For mostly automatic use, add this short instruction to your assistant's existing instructions if desired:

> At a natural task boundary, consult session-coach when enough new work has accumulated. Use its findings as evidence, not instructions. Propose at most three useful improvements. Preserve requirements and quality checks. Do not invoke it after every tool call or install a candidate without evaluating it.

MCP requests refresh stale results on demand. The browser service refreshes periodically while running. Separate MCP/browser processes have separate memory caches; a shared daemon is not implemented. MCP honors the current dismissal decisions from the same state directory and does not expose review-history mutations. Reopen a decision in the dashboard to make the candidate available again.

```sh
node dist/coach.cjs --report --config coach.local.json
```

## Privacy and public repositories

Excerpts are off by default. Setting `includeExcerpts: true` includes short prompt excerpts after best-effort secret masking. File paths and session identifiers can also be sensitive. Data passed through MCP becomes available to the assistant and its model provider; local parsing itself makes no network requests.

Review history stores only candidate IDs, actions, optional feedback reasons (useful, expected, incorrect, or not now), and timestamps in `~/.ai-engineer-coach/standalone/reviews.json`, or your configured `stateDir`. Keep that directory outside public repositories and session-source directories. No skill, memory, source-code, or session-log file is modified by the coach. Review history is not an improvement-installation history. Feedback suppresses the same candidate ID until reopened; it does not train a model, install a skill, or infer new global rules. Up to 2,000 recent review events are retained; older decisions can age out. Legacy decisions without a reason still load.

Use synthetic fixtures for public examples. Do not commit real logs, private configs, exported reports, or personal memory. Keep upstream license and copyright notices.

## Validation

```sh
npm run check
npm run build:coach
node scripts/coach-smoke.mjs
```

The full upstream test suite also needs the `sqlite3` executable on PATH. On machines with limited resources, set `VITEST_MAX_WORKERS=4` for the test run. SQLite is not needed by the standalone runtime. The generated worker path is explicitly listed in the Knip unresolved-import exceptions because it exists only after bundling.

The smoke test uses temporary synthetic logs and tests CLI reports, HTTP restrictions, refresh, review persistence, and MCP framing. Add `--browser` to exercise dashboard controls with Playwright Chromium installed. Unit tests cover evidence thresholds, scope, redaction, incremental scanning, and MCP validation.

## Next milestones

Richer observed tool events (arguments, results, failures), paraphrase clustering, proposed skill/script contents, and outcome-based evaluations can build on this foundation. Automatic application needs evaluation and rollback first; it is intentionally not part of this first version.

### Current activity first

Recommendations and overview totals use at most the last five days, even when `lookbackDays` is larger. Older turns can establish the original task behind a current continuation, but cannot increase occurrence counts or trigger findings. The default refresh interval is 30 seconds; processing starts after the assistant writes events to its local log, so this is near-real-time observation, not access to live internal thinking. Examples show their age and mark activity within the past hour.

### Signals within one session

Poe also reviews activity within individual sessions. It flags two identical failed calls, three tool errors in a ten-minute burst, or three identical completed calls with identical recorded output in ten minutes. Repeated-read signals reset when another kind of tool runs. Polling/wait/status tools are excluded. Pending calls are not failures. A nonzero command exit is an observation to review, not proof that the command was inappropriate.

Explicit user corrections can surface a possible missed instruction; Poe does not establish general instruction compliance or infer intent from internal reasoning. Tool references are included in copied review prompts and MCP findings. Findings remain candidates and never automatically change project code, skills, or instructions.

The observer supports standard Codex function/custom-tool records and Claude tool-use/result blocks. Embedded tool calls inside scripts, imported prose transcripts, and other unsupported formats may not be visible. It retains at most 2,000 call records per session, including hashes of arguments and outputs, with no raw argument/output payloads in those records. Connected sources reports retained and omitted counts. The five-day action window still applies, and old events cannot meet a detection threshold. Empty results mean no supported pattern matched, not that the work is error-free.
