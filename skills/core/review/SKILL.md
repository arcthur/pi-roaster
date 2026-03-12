---
name: review
description: Assess change risk, plan conformance, and merge safety with findings-first
  output and explicit residual risk.
stability: stable
dispatch:
  suggest_threshold: 10
  auto_threshold: 18
intent:
  outputs:
    - review_report
    - review_findings
    - merge_decision
  output_contracts:
    review_report:
      kind: text
      min_words: 3
      min_length: 18
    review_findings:
      kind: json
      min_items: 1
    merge_decision:
      kind: enum
      values:
        - ready
        - needs_changes
        - blocked
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
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
    - lsp_diagnostics
    - lsp_symbols
    - lsp_find_references
    - ast_grep_search
    - ledger_query
    - skill_complete
references:
  - references/boundary-failure.md
  - references/contract-drift.md
  - references/security-concurrency.md
consumes:
  - change_set
  - design_spec
  - verification_evidence
  - impact_map
requires: []
---

# Review Skill

## Intent

Judge risk, not style. Surface the highest-value findings first and make merge safety explicit.

## Trigger

Use this skill when:

- reviewing a diff or change plan
- checking merge readiness
- assessing regression, compatibility, or operational risk

## Workflow

### Step 1: Build review context

Summarize scope, intent, critical paths, and available evidence.

### Step 2: Evaluate risk lanes

Inspect correctness, compatibility, data mutation, external exposure, and operational failure modes.

### Step 3: Emit findings-first output

Produce:

- `review_findings`: ordered issues with evidence
- `review_report`: scope, assumptions, gaps, residual risk
- `merge_decision`: `ready`, `needs_changes`, or `blocked`

## Stop Conditions

- there is no concrete review target
- verification evidence is too weak to support a merge decision
- the real work is debugging or repository analysis, not review

## Anti-Patterns

- leading with summaries before findings
- focusing on style while skipping behavior risk
- claiming merge safety without evidence or assumptions

## Example

Input: "Review the skills v2 runtime refactor for regressions and missing tests."

Output: `review_findings`, `review_report`, `merge_decision`.
