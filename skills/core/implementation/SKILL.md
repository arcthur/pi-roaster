---
name: implementation
description: "Execute code changes using the right mode for the local situation: direct
  patch, test-first, or coordinated rollout."
stability: stable
intent:
  outputs:
    - change_set
    - files_changed
    - verification_evidence
  output_contracts:
    change_set:
      kind: text
      min_words: 3
      min_length: 18
    files_changed:
      kind: json
      min_items: 1
    verification_evidence:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - workspace_write
    - local_exec
    - runtime_observe
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
    - edit
  fallback_tools:
    - grep
    - exec
    - lsp_diagnostics
    - ledger_query
    - skill_complete
composable_with:
  - debugging
  - runtime-forensics
consumes:
  - design_spec
  - execution_plan
  - execution_mode_hint
  - root_cause
  - fix_strategy
requires: []
---

# Implementation Skill

## Intent

Ship the smallest correct change set and choose the implementation mode from evidence, not habit.

## Trigger

Use this skill when:

- the task is ready for code changes
- the fix or feature is already understood well enough to execute
- verification evidence must be produced alongside the change

## Workflow

### Step 1: Choose mode

Pick one:

- `direct_patch` for local, low-risk edits
- `test_first` when behavior needs to be pinned before the change
- `coordinated_rollout` for multi-file or cross-boundary work

Respect `execution_mode_hint` when present, but override it if the actual scope disagrees.

### Step 2: Apply the change

Read before editing, keep the diff local, and avoid incidental cleanup.

### Step 3: Emit execution artifacts

Produce:

- `change_set`: what changed and why
- `files_changed`: concrete file list
- `verification_evidence`: commands, diagnostics, or runtime evidence

If verification blocks completion, expect runtime to hand control to the debug
loop. Preserve the attempted evidence so `runtime-forensics` or `debugging` can
continue from the failure snapshot instead of re-deriving context from scratch.

## Stop Conditions

- the requested change implies a larger design problem than the current plan covers
- the root cause is still uncertain
- available verification is too weak to justify completion

## Anti-Patterns

- treating execution mode as a routing problem for another public skill
- rewriting large surfaces for a local change
- claiming completion without concrete verification evidence

## Example

Input: "Implement the routing profile model and update the registry index generation."

Output: `change_set`, `files_changed`, `verification_evidence`.
