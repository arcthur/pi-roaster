---
name: debugging
description: Reproduce failures, rank hypotheses, confirm root cause, and define the
  minimum valid fix strategy.
stability: stable
intent:
  outputs:
    - root_cause
    - fix_strategy
    - failure_evidence
  output_contracts:
    root_cause:
      kind: text
      min_words: 3
      min_length: 18
    fix_strategy:
      kind: text
      min_words: 3
      min_length: 18
    failure_evidence:
      kind: text
      min_words: 2
      min_length: 12
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 100
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 140
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - read
    - exec
    - grep
  fallback_tools:
    - lsp_diagnostics
    - ast_grep_search
    - ledger_query
    - skill_complete
references:
  - references/failure-triage.md
consumes:
  - repository_snapshot
  - impact_map
  - verification_evidence
  - runtime_trace
requires: []
---

# Debugging Skill

## Intent

Convert a failure signal into a confirmed root cause and a bounded fix strategy.

## Trigger

Use this skill when:

- tests or runtime behavior fail unexpectedly
- a regression appears after recent changes
- the team needs causal confidence before patching

## Workflow

### Step 1: Reproduce exactly

Capture the failing command, first error line, and the affected boundary.

### Step 2: Rank hypotheses

Keep at most three active hypotheses and falsify the most likely first.

If the failure looks like a regression or ownership drift, check recent history
before settling on a hypothesis. Use `git-ops` history-search patterns for
introducer lookup, blame, and similar-fix archaeology.

### Step 3: Confirm the cause

Do not patch. Produce:

- `root_cause`: single dominant cause
- `fix_strategy`: minimum valid repair approach
- `failure_evidence`: before-state evidence and commands

## Stop Conditions

- the issue cannot be reproduced with current information
- three ranked hypotheses are exhausted with no confirmed cause
- the real blocker is missing runtime or repository context

## Anti-Patterns

- patching on the first plausible explanation
- expanding into broad refactor before confirming the cause
- treating flaky symptoms as proof of root cause

## Example

Input: "Typecheck passes, but cascade events stop reconciling after session replay."

Output: `root_cause`, `fix_strategy`, `failure_evidence`.
