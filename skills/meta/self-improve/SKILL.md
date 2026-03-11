---
name: self-improve
description: Distill recurring failures, weak heuristics, or review patterns into explicit improvement hypotheses and follow-up changes.
stability: experimental
effect_level: mutation
tools:
  required: [read, grep]
  optional: [ledger_query, tape_search, cost_view, exec, edit, process, skill_complete]
  denied: [write]
budget:
  max_tool_calls: 80
  max_tokens: 150000
references:
  - references/promotion-targets.md
scripts:
  - scripts/activator.sh
  - scripts/error-detector.sh
  - scripts/extract-skill.sh
  - scripts/promote.sh
  - scripts/review.sh
  - scripts/setup.sh
outputs: [improvement_hypothesis, learning_backlog, improvement_plan]
output_contracts:
  improvement_hypothesis:
    kind: informative_text
    min_words: 3
    min_length: 18
  learning_backlog:
    kind: informative_list
    min_items: 1
    allow_objects: true
    min_words: 2
    min_length: 12
  improvement_plan:
    kind: informative_text
    min_words: 3
    min_length: 18
consumes: [review_report, runtime_trace, artifact_findings]
requires: []
---

# Self Improve Skill

## Intent

Turn repeated mistakes or friction into explicit learning loops instead of one-off observations.

Use the helper scripts to initialize workspace learning logs, mine repeated failures,
and promote high-value patterns into v2 skill categories, project overlays, or shared project rules. Templates for
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
