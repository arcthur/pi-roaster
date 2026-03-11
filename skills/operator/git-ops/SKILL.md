---
name: git-ops
description: Handle commit shaping, history inspection, and non-destructive branch operations with explicit safety gates.
stability: stable
effect_level: execute
tools:
  required: [exec, read]
  optional: [grep, ledger_query, skill_complete]
  denied: []
budget:
  max_tool_calls: 80
  max_tokens: 140000
references:
  - references/conventional-commits.md
  - references/history-search-cheatsheet.md
  - references/rebase-workflow.md
scripts:
  - scripts/detect-commit-style.sh
outputs: [git_context, commit_plan, git_operation_report]
output_contracts:
  git_context:
    kind: informative_text
    min_words: 3
    min_length: 18
  commit_plan:
    kind: one_of
    variants:
      - kind: informative_text
        min_words: 3
        min_length: 18
      - kind: informative_list
        min_items: 1
        allow_objects: true
        min_words: 2
        min_length: 12
  git_operation_report:
    kind: informative_text
    min_words: 3
    min_length: 18
consumes: [change_set, files_changed, verification_evidence, review_report]
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
