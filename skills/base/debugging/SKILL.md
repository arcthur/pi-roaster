---
name: debugging
description: Use when encountering any bug, test failure, or unexpected behavior — before proposing fixes.
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
outputs: [oracle_brief, oracle_synthesis, root_cause, fix_description, evidence, verification]
consumes: [architecture_map, execution_steps]
escalation_path:
  hypothesis_exhausted: exploration
  fix_creates_regressions: planning
---

# Debugging Skill

## Intent

Reproduce failures reliably, isolate root cause, apply minimal fix, and verify without regressions.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Step 3 (hypothesis validation), you cannot apply fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

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

### Step 4: Deep consultation checkpoint (conditional)

Consult external deep reasoning only when needed:

- no hypothesis can be confirmed after initial validation attempts
- failure appears non-deterministic (timing/order/concurrency)
- impact crosses module boundaries and local signal is weak

Build `ORACLE_BRIEF` and normalize response into `ORACLE_SYNTHESIS` using:
`skills/base/planning/references/oracle-consultation-protocol.md`.

Hard rules:

- consultation is advisory, not proof
- keep local reproduction and falsification steps authoritative
- maximum 3 consultation rounds per debugging task

### Step 5: Validate hypotheses one by one

Validation order:

1. Read implicated files and call chain.
2. Correlate with error stack and data flow.
3. Run a focused command to confirm/refute.

Validation checklist:

- Does the suspected line execute in failing path?
- Does input/state at that line match expectation?
- Does changing only this point explain observed error?

If hypothesis is refuted, document reason and move to next.

### Step 6: Apply minimal fix

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

### Step 7: Verify in two layers

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

If required verification commands are unavailable, emit `TOOL_BRIDGE` using
`skills/base/planning/references/executable-evidence-bridge.md` with a reproducible script path and success criteria.

### Step 8: Emit final debugging report

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
- Required verification cannot run and no meaningful `TOOL_BRIDGE` can be produced.

When stopping, provide:

1. what was tried
2. strongest remaining hypothesis
3. minimal missing input required from user

## Red Flags — STOP and Return to Step 1

If you catch yourself thinking:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Here are the main problems" (listing fixes without investigation)
- Proposing solutions before tracing data flow
- "One more fix attempt" (when already tried 2+)

**ALL of these mean: STOP. Return to Step 1.**

**If 3+ fixes failed**: Question the architecture — each fix revealing new problems in different places indicates an architectural issue, not a local bug. Stop and discuss before attempting more fixes.

## Common Rationalizations

| Excuse                                     | Reality                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| "Issue is simple, don't need process"      | Simple issues have root causes too. Process is fast for simple bugs.    |
| "Emergency, no time for process"           | Systematic debugging is FASTER than guess-and-check thrashing.          |
| "Just try this first, then investigate"    | First fix sets the pattern. Do it right from the start.                 |
| "I see the problem, let me fix it"         | Seeing symptoms ≠ understanding root cause.                             |
| "Multiple fixes at once saves time"        | Can't isolate what worked. Causes new bugs.                             |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |

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
