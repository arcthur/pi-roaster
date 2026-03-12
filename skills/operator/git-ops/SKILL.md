---
name: git-ops
description: Handle commit shaping, history inspection, and non-destructive branch
  operations with explicit safety gates.
stability: stable
intent:
  outputs:
    - git_context
    - commit_plan
    - git_operation_report
  output_contracts:
    git_context:
      kind: text
      min_words: 3
      min_length: 18
    commit_plan:
      kind: json
      min_items: 1
    git_operation_report:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - exec
    - read
  fallback_tools:
    - grep
    - ledger_query
    - skill_complete
references:
  - references/conventional-commits.md
  - references/history-search-cheatsheet.md
  - references/rebase-workflow.md
scripts:
  - scripts/detect-commit-style.sh
consumes:
  - change_set
  - files_changed
  - verification_evidence
  - review_report
requires: []
---

# Git Ops Skill

## Intent

Create reviewable history and safe branch operations without treating Git mechanics as an ordinary routed coding skill.

## Trigger

Use this skill when:

- commits need to be created or shaped
- history must be inspected for evidence
- a safe branch operation is requested

## Workflow

### Step 1: Gather branch safety context

Inspect worktree state, branch, upstream, and diff shape.

### Step 2: Choose the operation

Pick `commit`, `history_search`, or another safe Git operation with the minimum required blast radius.

### Step 3: Emit Git artifacts

Produce:

- `git_context`: worktree and branch state
- `commit_plan`: atomic grouping and message approach
- `git_operation_report`: what changed and what remains risky

## Stop Conditions

- the requested operation is destructive or hard to roll back without explicit intent
- branch state is unclear
- the task is really review or GitHub workflow, not Git history manipulation

## Anti-Patterns

- rewriting history by default
- mixing unrelated changes into one commit plan
- treating Git style detection as a substitute for change review

## Example

Input: "Split this refactor into reviewable commits and summarize the safe execution order."

Output: `git_context`, `commit_plan`, `git_operation_report`.
