# Poe architecture plan

## Goal

Poe is a local system that studies Codex, Claude Code, VS Code, and Copilot sessions to explain:

- what the assistant was asked to do;
- how the observable work progressed;
- which resources it consumed;
- whether the result was verified or useful;
- which small change may improve future work.

Poe must not call a model during normal analysis or claim savings without measurements.

## Architecture

```text
Local session logs
        |
        v
TypeScript source adapters
        |
        v
Versioned evidence events
        |
        v
Python analysis worker ----> Local SQLite database
        |                           |
        +----------+----------------+
                   v
          Findings and evaluations
                   |
          +--------+---------+
          v                  v
     Web dashboard       Local MCP tools
```

## Components

### TypeScript collector

- Reuse the existing Codex, Claude Code, VS Code, and Copilot parsers.
- Read logs incrementally and without modifying them.
- Preserve source-specific token meanings.
- Produce stable session, turn, reasoning, and tool-event identifiers.
- Export metadata by default and secret-redacted previews only when enabled.

### Evidence format

Use a versioned JSONL stream between TypeScript and Python. Records cover:

- sources and parser coverage;
- sessions and turns;
- prompts and responses as hashes, previews, or transient text;
- reasoning observations;
- tool calls, results, failures, and retries;
- token usage and counter scope;
- edits, checks, outcomes, findings, and user reviews.

Every conclusion must reference its evidence records.

### Python analysis worker

- Validate and ingest evidence into SQLite.
- Reconstruct task contracts and observable work trajectories.
- Calculate token, tool, retry, context, timing, and outcome features.
- Run deterministic rules before introducing semantic models.
- Compare only similar tasks and report uncertainty.
- Return structured findings to TypeScript.

The first version uses only the Python standard library.

### Local database

SQLite stores normalized evidence, derived facts, findings, reviews, and experiments. Raw transcript
text remains absent by default. Transient analysis may process full text locally without persisting it.

### Dashboard

The main views are:

1. Overview: current activity, coverage, significant changes, and recent findings.
2. Sessions: task, event timeline, tools, tokens, checks, and outcome.
3. Usage: input, output, cache, reasoning, latency, and coverage by source.
4. Findings: evidence, impact, recommendation, confidence, and review status.
5. Experiments: baseline, candidate, comparable tasks, results, and uncertainty.

### MCP

MCP exposes compact local findings and evidence to Codex or Claude Code when requested. MCP does not
consume tokens by itself. An assistant consumes tokens only when it calls Poe and processes the result.

## Analysis model

Poe separates:

- **Recorded facts:** direct log values.
- **Derived facts:** deterministic calculations.
- **Interpretations:** conclusions that may be wrong.

Poe evaluates five dimensions independently:

1. Task understanding and constraint retention.
2. Reasoning trajectory and evidence use.
3. Tool execution, failures, retries, and verification.
4. Token, context, latency, and cache consumption.
5. Outcome quality, corrections, acceptance, and rework.

There is no single intelligence score. Efficiency means resources used per validated outcome.

## Runtime and privacy

- One local TypeScript process serves the dashboard and supervises workers.
- Parsing and Python analysis run outside the dashboard's main execution path.
- No telemetry or remote analysis.
- Source logs are read-only.
- Secrets are redacted from previews.
- Database location and retention are configurable.
- Python failure does not stop collection or the existing dashboard.

## Initial limits

- Hidden or encrypted reasoning cannot be recovered.
- Some clients expose incomplete token counters.
- Subscription limit windows require provider-reported data.
- A repeated action is not waste unless evidence shows no new state or progress.
- Historical data informs context; current recommendations use the recent five-day window.

## Selected decisions

- Keep TypeScript for collection, dashboard, and MCP.
- Use Python for analytical work.
- Use JSONL as the process boundary and SQLite for local storage.
- Start with deterministic rules and measured outcomes.
- Add local models, embeddings, or remote evaluators only after they show measured value.
