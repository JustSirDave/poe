# Poe build plan

## Current foundation

Already available:

- local dashboard and MCP bridge;
- Codex, Claude Code, VS Code, and Copilot ingestion;
- five-day current-analysis window;
- tool failures, retry signals, reasoning observations, and token history;
- versioned metadata-first analysis dataset;
- optional secret-redacted previews;
- user review history.

## Phase 1: Python evidence engine

Build:

- Python worker using the standard library;
- JSONL validation and incremental SQLite ingestion;
- schema and parser version tracking;
- analysis watermark, duration, error, and coverage status;
- dashboard Evidence coverage section.

First rules:

1. Identical failed call repeated without a state change.
2. Changed retries that continue failing for the same error category.
3. Unchanged file reread within one task.
4. Tool result requested again before the previous result was used.
5. Code changed without recorded verification.

Done when every finding links to exact events and no missing field is treated as zero.

## Phase 2: Task and trajectory analysis

Build:

- task contract: outcome, constraints, definition of done, authorization, and output requirements;
- follow-up and correction tracking;
- plan, action, evidence, decision, and verification event relationships;
- detection of lost constraints, unsupported completion claims, and repeated planning without action;
- session timeline showing what changed after each costly action.

Use transient local text processing. Persist derived features, hashes, and approved previews only.

Done when Poe can explain why a finding exists without claiming access to hidden reasoning.

## Phase 3: Outcome and quality evaluation

Build:

- connect edits to checks and checks to final claims;
- deterministic outcomes from tests, exit codes, schema checks, and artifact existence;
- user outcomes: accepted, corrected, rejected, abandoned, or later reworked;
- task-specific quality dimensions;
- resource-per-validated-outcome metrics.

Done when token efficiency is shown only beside quality and evidence coverage.

## Phase 4: Experiments

Build:

- baseline and candidate versions for prompts, skills, memory, and effort settings;
- comparable task sets;
- paired outcome comparison;
- median, percentiles, effect size, and bootstrap confidence intervals;
- experiment history and rollback decision.

Start with prompt ablation and controlled comparisons. Do not automate prompt optimization yet.

Done when Poe can measure whether a change preserved quality and reduced resources.

## Phase 5: Practical recommendations

Build:

- recommend a skill only after a repeated successful procedure is demonstrated;
- recommend memory only for durable preferences or facts;
- recommend effort changes by task type and measured outcome;
- generate compact follow-up prompts from the current task state;
- allow safe, reversible recommendations to be applied and measured.

Codex and Claude integration remains optional. Normal local analysis continues without model calls.

## Later, only if justified

- local embeddings for semantic grouping;
- a local language model for task classification;
- OpenTelemetry live instrumentation;
- provider limit-window connectors;
- Parquet export for large research datasets;
- validated model-based evaluation;
- automatic multi-objective optimization.

## Build order

1. Python worker and SQLite ingestion.
2. Evidence coverage UI.
3. Five deterministic session rules.
4. Task contract and trajectory reconstruction.
5. Outcome linkage and quality measures.
6. Experiment engine.
7. Recommendations and optional assistant integration.

## Quality gates

- No network request during deterministic analysis.
- No session-log modification.
- No finding without traceable evidence.
- No token-savings claim without a measured comparison.
- No comparison across incompatible token-counter scopes.
- No stale session used as the current behavioral baseline.
- No recommendation that removes required checks or reduces verified quality.
- Parser, worker, and dashboard failures remain visible and recoverable.
