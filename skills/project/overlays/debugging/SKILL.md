---
intent:
  outputs:
    - root_cause
    - fix_strategy
    - failure_evidence
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 160000
execution_hints:
  preferred_tools:
    - read
    - exec
    - grep
  fallback_tools:
    - ledger_query
    - tape_search
    - cost_view
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/runtime-artifacts.md
consumes:
  - repository_snapshot
  - impact_map
  - verification_evidence
  - runtime_trace
---

# Brewva Debugging Overlay

## Intent

Make Brewva debugging distinguish clearly between source bugs and runtime-artifact symptoms.

## Trigger

Use this overlay when debugging Brewva itself.

## Workflow

### Step 1: Split source vs runtime evidence

Check whether the failure is in code paths, runtime artifacts, or both.

### Step 2: Bias to deterministic proof

Prefer reproducible commands, event traces, and artifact correlations over speculation.

## Stop Conditions

- the issue cannot be separated into source behavior vs artifact behavior
- there is no reproducible signal yet

## Anti-Patterns

- attributing every replay or projection symptom to runtime bugs without artifact inspection
- patching around telemetry mismatches instead of finding the causal break

## Example

Input: "Why did replay keep an outdated cascade intent after the taxonomy refactor?"
