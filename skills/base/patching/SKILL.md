---
name: patching
description: Make minimal surgical code changes with explicit verification.
version: 1.0.0
stability: stable
tier: base
tags: [patch, edit, fix, implement]
anti_tags: [research, architecture]
tools:
  required: [read, edit]
  optional: [grep, lsp_diagnostics, ledger_query, exec, skill_complete]
  denied: [write]
budget:
  max_tool_calls: 70
  max_tokens: 130000
outputs: [change_summary, files_changed, verification]
consumes: [execution_steps, root_cause, fix_description]
escalation_path:
  api_change_needed: planning
  repeated_patch_failure: debugging
---

# Patching Skill

## Intent

Apply the smallest correct patch that resolves the target issue without collateral refactor.

## Trigger

Use this skill when a user asks to:

- fix or adjust existing behavior
- modify code in a known location
- implement a small scoped requirement

Do not use this skill for broad architecture redesign.

## Procedure

### Step 1: Define change boundary (mandatory)

Read target file(s) and identify:

- exact function/type/block that must change
- required adjacent code for correctness
- out-of-scope nearby code that must remain untouched

Blocking output:

```text
CHANGE_BOUNDARY
- target: "<path:symbol>"
- must_change_lines: "<logical region>"
- do_not_touch:
  - "<region>"
  - "<region>"
```

### Step 2: Choose edit strategy (decision tree)

Use this decision tree before editing:

1. If fix fits existing function/type shape -> `EDIT_EXISTING`.
2. If fix needs tiny helper used in one place -> `ADD_LOCAL_HELPER`.
3. If fix requires changing public signature/persistence format -> pause and switch to planning.

Hard rules:

- Prefer `edit` operation over full file rewrite.
- Preserve naming style, import order, and formatting style.
- Keep diff local to root-cause area.

### Step 3: Apply minimal patch

Minimal patch standards:

- no unrelated rename
- no incidental whitespace churn
- no style-only rewrite
- no opportunistic refactor

When touching multiple files, each file must satisfy one of:

- directly required by compilation/type checks
- directly required by runtime behavior
- direct test paired with changed implementation

### Step 4: Verify patch in layered order

Layered verification sequence:

1. diagnostics for changed scope
2. targeted test command
3. broader project checks only if risk is non-local

Example sequence:

```bash
bun run typecheck
bun test <target>
```

### Step 5: Emit patch summary

```text
PATCH_REPORT
- change_summary: "<what changed and why>"
- files_changed:
  - <path>
  - <path>
- verification:
  - "<check + result>"
- residual_risk: "<if any>"
```

## Boundary Heuristics

- Prefer extending existing branch/condition over introducing new abstraction.
- Keep call graph depth unchanged unless bug explicitly requires restructuring.
- If adding configuration, default to backward-compatible behavior.

## Stop Conditions

- Required fix implies public API or data contract change not in request.
- Repeated minimal patches fail due to hidden architectural issue.
- Verification requires commands or environment not available.

When stopping, provide exact blocker and recommended next planning scope.

## Anti-Patterns (never)

- Rewriting entire file for a local change.
- Combining bug fix and cleanup refactor in one patch.
- Editing tests first to force green status.
- Introducing new dependencies for a small local fix.

## Example

Input:

```text
"Fix offset calculation in ledger digest."
```

Expected path:

1. Locate digest function and boundary.
2. Edit only offset logic and immediate callers if required.
3. Run typecheck and focused tests.
4. Return `PATCH_REPORT` with changed files and evidence.
