---
name: self-improve
description: Distill recurring failures, weak heuristics, or review patterns into
  explicit improvement hypotheses and follow-up changes.
stability: experimental
intent:
  outputs:
    - improvement_hypothesis
    - learning_backlog
    - improvement_plan
  output_contracts:
    improvement_hypothesis:
      kind: text
      min_words: 3
      min_length: 18
    learning_backlog:
      kind: json
      min_items: 1
    improvement_plan:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - workspace_write
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 150000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 210000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - ledger_query
    - tape_search
    - cost_view
    - exec
    - edit
    - process
    - skill_complete
references:
  - references/promotion-targets.md
scripts:
  - scripts/activator.sh
  - scripts/error-detector.sh
  - scripts/extract-skill.sh
  - scripts/promote.sh
  - scripts/review.sh
  - scripts/setup.sh
consumes:
  - review_report
  - runtime_trace
  - artifact_findings
requires: []
---

# Self Improve Skill

## Intent

Turn repeated mistakes or friction into explicit learning loops instead of one-off observations.

Use the helper scripts to initialize workspace learning logs, mine repeated failures,
and promote high-value patterns into current skill categories, project overlays, or shared project rules. Templates for
workspace learning files live under `assets/`.

## Trigger

Use this skill when:

- the same failure pattern keeps recurring
- review findings reveal a systemic weakness
- runtime forensics show repeated operational waste

## Workflow

### Step 1: Collect repeated signals

Identify patterns across reviews, runtime traces, or failure artifacts.

### Step 2: Distill improvement candidates

Produce:

- `improvement_hypothesis`: the suspected systemic weakness
- `learning_backlog`: ranked fixes or experiments
- `improvement_plan`: the smallest next iteration to test

## Stop Conditions

- there is only a single isolated incident
- no repeated pattern can be justified from evidence
- the real need is immediate debugging or implementation, not learning

## Anti-Patterns

- calling every bug a system-level lesson
- proposing broad rewrites without evidence of repetition
- mixing retrospective learning with immediate incident response

## Example

Input: "We keep shipping weak skill boundaries; distill what should change in the catalog design rules."

Output: `improvement_hypothesis`, `learning_backlog`, `improvement_plan`.
