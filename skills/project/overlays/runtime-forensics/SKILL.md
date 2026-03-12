---
intent:
  outputs:
    - runtime_trace
    - session_summary
    - artifact_findings
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
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
references:
  - skills/project/shared/runtime-artifacts.md
consumes: []
---

# Brewva Runtime Forensics Overlay

## Intent

Focus runtime forensics on Brewva-native artifacts and governance telemetry.

## Trigger

Use this overlay when analyzing Brewva runtime sessions.

## Workflow

### Step 1: Start from canonical artifact paths

Inspect event store, evidence ledger, projection artifacts, WAL, and schedule projection before ad hoc searches.

### Step 2: Correlate governance and cascade behavior

Prefer event families and artifact joins that explain routing, cascade, context, and verification decisions.

## Stop Conditions

- the relevant session cannot be identified
- required artifacts are absent from the workspace

## Anti-Patterns

- treating log snippets as enough when the artifact graph is available
- skipping governance events when investigating control-plane behavior

## Example

Input: "Trace how the new routing scopes affected runtime selection and cascade planning in one session."
