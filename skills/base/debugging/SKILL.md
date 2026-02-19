---
name: debugging
description: Systematic bug diagnosis with hypotheses and reproducible verification.
version: 1.0.0
stability: stable
tier: base
tags: [debug, bug, failure, regression]
anti_tags: [feature]
tools:
  required: [read, exec, grep]
  optional: [lsp_diagnostics, ast_grep_search, edit, ledger_query, skill_complete]
  denied: []
budget:
  max_tool_calls: 90
  max_tokens: 150000
outputs: [root_cause, fix_description, evidence, verification]
consumes: [architecture_map, execution_steps]
escalation_path:
  hypothesis_exhausted: exploration
  fix_creates_regressions: planning
---

# Debugging Skill

## Intent

Reproduce failures reliably, isolate root cause, apply minimal fix, and verify without regressions.

## Trigger

Use this skill for:

- Test or runtime failures.
- Regressions after recent changes.
- Intermittent behavior that still has a reproducible signal.

Do not use this skill for feature implementation without a failure signal.

## Procedure

### Step 1: Capture failure signal (mandatory)

Collect exact failure context first:

- failing command
- full error output
- failing file and line hints
- expected behavior vs actual behavior

If the user does not provide a command, request one command that reproduces the issue.

Blocking output:

```text
DEBUG_SIGNAL
- command: "<exact command>"
- failure_type: <compile|test|runtime|integration|unknown>
- first_error_line: "<copied line>"
- affected_scope: "<module or feature>"
```

### Step 2: Reproduce exactly (mandatory)

Run the exact command from Step 1 before reading broad code.

Recommended command patterns:

```bash
# Keep full output for diagnosis
bun test <target> 2>&1
bun run typecheck 2>&1
```

Rules:

- If reproduction fails (cannot reproduce), stop and ask for missing context.
- Do not patch before successful reproduction.
- Do not broaden scope until first reproduction is captured.

### Step 3: Generate ranked hypotheses (max 3)

Each hypothesis must include:

1. one-sentence cause statement
2. file:line to inspect
3. validation action that can falsify it

Template:

```text
HYPOTHESIS_1 (most likely)
- cause: "<statement>"
- inspect: "<path:line>"
- validation: "<command or read target>"

HYPOTHESIS_2
...

HYPOTHESIS_3
...
```

Hard rules:

- Maximum 3 active hypotheses.
- Maximum 3 tool calls per hypothesis before moving on.
- Never apply a fix before at least one hypothesis is confirmed.

### Step 4: Validate hypotheses one by one

Validation order:

1. Read implicated files and call chain.
2. Correlate with error stack and data flow.
3. Run a focused command to confirm/refute.

Validation checklist:

- Does the suspected line execute in failing path?
- Does input/state at that line match expectation?
- Does changing only this point explain observed error?

If hypothesis is refuted, document reason and move to next.

### Step 5: Apply minimal fix

Fix only confirmed root cause lines.

Change boundary rules:

- Prefer surgical edit over rewrite.
- Keep public API unchanged unless failure requires API change.
- Do not bundle cleanup/refactor with bug fix.
- Avoid speculative guards that only hide symptoms.

Blocking output before verification:

```text
FIX_PLAN
- root_cause: "<confirmed cause>"
- files_to_change:
  - <path>
- why_minimal: "<why this is smallest valid fix>"
```

### Step 6: Verify in two layers

Layer A: exact repro command from Step 2.
Layer B: broader safety check for nearby regressions.

Verification sequence:

```bash
# Layer A: exact reproduction command
bun test <same-target-as-step-2>

# Layer B: broader check
bun test
```

If Layer A passes but Layer B fails:

- report as partial success
- list new failures and probable relation
- avoid claiming full completion

### Step 7: Emit final debugging report

```text
DEBUG_REPORT
- root_cause: "<single sentence>"
- fix_description: "<what changed>"
- evidence:
  - "<before signal>"
  - "<after signal>"
- verification: <pass|partial|fail>
- residual_risk: "<if any>"
```

## Decision Shortcuts

- Compile/type errors: start at first compiler error, not downstream cascades.
- Test assertion mismatch: inspect fixture/setup before business logic.
- Runtime null/undefined errors: validate data contract and call path entry.
- Flaky tests: classify deterministic vs timing/order dependency before editing.

## Stop Conditions

- Cannot reproduce after two explicit attempts with the provided command.
- Three hypotheses are exhausted with no confirmed root cause.
- Proposed fix creates two or more new failing tests.
- Tool-call budget exceeds configured limit without convergence.

When stopping, provide:

1. what was tried
2. strongest remaining hypothesis
3. minimal missing input required from user

## Anti-Patterns (never)

- Fixing symptom lines without tracing call chain.
- Adding broad `try/catch` to suppress failure.
- Editing test expectations to match buggy behavior.
- Mixing refactor with bug fix in one patch.
- Claiming "fixed" without rerunning the original failing command.

## References

- Failure classification and triage prompts: `skills/base/debugging/references/failure-triage.md`

## Example

Input:

```text
"`bun test test/runtime/runtime.test.ts` fails with a type mismatch in digest.ts."
```

Expected workflow:

1. Reproduce exact test failure.
2. Produce 1-3 ranked hypotheses with file targets.
3. Confirm one root cause and apply minimal edit.
4. Rerun same test, then broader suite.
5. Return `DEBUG_REPORT` with evidence lines.
