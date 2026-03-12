---
name: goal-loop
description: Use bounded multi-run continuity when progress must span repeated executions
  and convergence can be judged from explicit evidence.
stability: experimental
dispatch:
  suggest_threshold: 12
  auto_threshold: 24
intent:
  outputs:
    - loop_contract
    - iteration_report
    - convergence_report
    - continuation_plan
  output_contracts:
    loop_contract:
      kind: text
      min_words: 3
      min_length: 18
    iteration_report:
      kind: text
      min_words: 3
      min_length: 18
    convergence_report:
      kind: text
      min_words: 2
      min_length: 12
    continuation_plan:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
    - schedule_mutation
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
  fallback_tools:
    - schedule_intent
    - task_view_state
    - ledger_query
    - skill_chain_control
    - skill_complete
references:
  - references/convergence-patterns.md
  - references/handoff-patterns.md
consumes:
  - design_spec
  - execution_plan
  - verification_evidence
requires: []
---

# Goal Loop Skill

## Intent

Represent cross-run continuity explicitly instead of pretending one interactive session can safely absorb long-running work.

## Trigger

Use this skill when:

- the user asks to continue work over time
- repeated execution is required to converge
- runtime-managed continuity is preferable to one long session

## Workflow

### Step 1: Prove loop viability

Confirm the goal, convergence signals, cadence, and exit path are explicit.

### Step 2: Encode the loop contract

Produce:

- `loop_contract`: goal, cadence, max runs, recovery path
- `continuation_plan`: what each run should attempt

### Step 3: Emit run-level evidence

On each pass, produce:

- `iteration_report`: slice attempted, evidence, status
- `convergence_report`: converged, blocked, or max-runs reached

## Stop Conditions

- the task should finish in one normal execution pass
- convergence cannot be defined from observable runtime signals
- the real work is still design or implementation, not continuity

## Anti-Patterns

- routing ordinary complex implementation here by default
- writing "keep trying until done" with no explicit convergence logic
- using continuity as a substitute for clear delivery boundaries

## Example

Input: "Keep shipping the migration work over the next few days and stop when the P0 checklist is fully verified."

Output: `loop_contract`, `iteration_report`, `convergence_report`, `continuation_plan`.
