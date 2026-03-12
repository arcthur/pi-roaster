---
name: runtime-forensics
description: Inspect Brewva runtime artifacts, event streams, ledgers, and projection
  outputs to explain what happened during execution.
stability: stable
intent:
  outputs:
    - runtime_trace
    - session_summary
    - artifact_findings
  output_contracts:
    runtime_trace:
      kind: text
      min_words: 3
      min_length: 18
    session_summary:
      kind: text
      min_words: 3
      min_length: 18
    artifact_findings:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 160000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 220000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - exec
    - ledger_query
    - tape_info
    - tape_search
    - cost_view
    - skill_complete
consumes: []
requires: []
---

# Runtime Forensics Skill

## Intent

Answer "what happened at runtime?" from artifacts and telemetry, not source guesses.
This skill is also the runtime-facing first responder for automatic debug-loop
handoffs when a mutation attempt fails verification.

## Trigger

Use this skill when:

- investigating session artifacts, event streams, or ledgers
- correlating runtime behavior across turns
- checking projection, WAL, or governance evidence

## Workflow

### Step 1: Locate relevant artifacts

Identify the session, files, and event families needed for the question.

### Step 2: Reconstruct the trace

Correlate events, ledger rows, and projection artifacts into one narrative.

### Step 3: Emit forensic artifacts

Produce:

- `runtime_trace`: ordered causal trace
- `session_summary`: high-level runtime state
- `artifact_findings`: anomalies, integrity issues, or useful evidence

## Stop Conditions

- required artifacts are missing
- the question is about source design, not runtime behavior
- session identity cannot be resolved

## Anti-Patterns

- mixing runtime forensics with source-level debugging guesses
- quoting raw JSONL without interpretation
- ignoring causal ordering across artifacts

## Example

Input: "Explain why the cascade intent paused after replay and point to the exact event sequence."

Output: `runtime_trace`, `session_summary`, `artifact_findings`.
