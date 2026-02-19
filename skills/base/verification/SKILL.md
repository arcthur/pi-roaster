---
name: verification
description: Validate changes with diagnostics, tests, and policy checks.
version: 1.0.0
stability: stable
tier: base
tags: [verify, test, lint, quality]
anti_tags: [explore]
tools:
  required: [exec, lsp_diagnostics, ledger_query]
  optional: [read, skill_complete]
  denied: []
budget:
  max_tool_calls: 45
  max_tokens: 100000
outputs: [checks, verdict, missing_evidence]
consumes: [change_summary, files_changed]
escalation_path:
  verification_fails: debugging
  command_unavailable: exploration
---

# Verification Skill

## Intent

Ensure changed behavior is proven by concrete evidence with explicit pass/fail criteria.

## Trigger

Use this skill after code changes or when user asks for confidence in correctness.

## Verification Sequence (mandatory order)

### Step 1: Define verification scope

Map changed files to required checks:

- type/compile checks
- targeted behavior tests
- broader regression tests
- policy/lint checks if configured

Blocking output:

```text
VERIFICATION_SCOPE
- changed_targets:
  - <path>
- required_checks:
  - <typecheck>
  - <test>
  - <lint/policy if needed>
```

### Step 2: Run checks in ordered layers

Required order:

1. typecheck or diagnostics
2. targeted tests for changed behavior
3. broader suite if impact is non-local
4. lint/policy checks last

Example:

```bash
bun run typecheck
bun test <target>
bun test
bun run lint
```

### Step 3: Classify outcomes

Per-check status:

- `pass`: command exits clean and output supports success.
- `fail`: command exits non-zero or clear failing evidence.
- `skip`: command unavailable or out-of-scope with reason.

### Step 4: Produce verdict

Verdict rules:

- `PASS`: all required checks pass.
- `PARTIAL`: critical checks pass but one or more non-critical checks fail/skip.
- `FAIL`: any critical check fails.

Critical checks usually include typecheck and target behavior tests.

Blocking output:

```text
VERIFICATION_REPORT
- checks:
  - name: "<check>"
    status: <pass|fail|skip>
    evidence: "<key output line>"
- verdict: <PASS|PARTIAL|FAIL>
- missing_evidence:
  - "<what is still required>"
```

## Diagnostic Guidance

- For compiler failures, prioritize first error line and dependent files.
- For test failures, separate pre-existing failures from new regressions.
- For flaky checks, rerun once and report instability explicitly.

## Stop Conditions

- Required verification command does not exist in environment.
- Command output is inconclusive after one rerun.
- Verification cannot be scoped because change set is unknown.

When stopped, emit exact missing command/info needed.

## Anti-Patterns (never)

- Claiming success without command evidence.
- Running broad test suites before targeted checks.
- Ignoring failed critical checks because other checks passed.
- Hiding skipped checks in summary.

## Example

Input:

```text
"Verify the gate fix does not regress runtime tests."
```

Expected flow:

1. Define scope from changed files.
2. Run typecheck then focused runtime tests.
3. Run broader suite if gate path is shared.
4. Emit `VERIFICATION_REPORT` with explicit verdict.
