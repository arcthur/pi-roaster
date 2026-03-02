---
name: tdd
description: Use when implementing any feature, bugfix, or behavior change — before writing implementation code.
version: 1.0.0
stability: stable
tier: base
tags: [tdd, test, red-green-refactor, implementation]
anti_tags: [explore, research, architecture]
tools:
  required: [read, exec]
  optional: [grep, edit, lsp_diagnostics, skill_complete]
  denied: []
budget:
  max_tool_calls: 80
  max_tokens: 140000
outputs: [tdd_target, tdd_cycle, tdd_report]
consumes: [execution_steps, root_cause, fix_description]
escalation_path:
  test_infrastructure_missing: exploration
  design_unclear: brainstorming
---

# Test-Driven Development Skill

## Intent

Enforce the RED-GREEN-REFACTOR cycle so every behavior change is proven by a test that was seen to fail first.

## Trigger

Use this skill for:

- Implementing a new feature or behavior.
- Fixing a bug with a known or suspected cause.
- Any change to production code that alters observable behavior.

Do not use this skill for pure refactors with no behavior change, or for exploratory research.

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

If you didn't watch the test fail, you don't know if it tests the right thing.

Violating the letter of the rules is violating the spirit of the rules.

## Procedure

### Step 1: Identify test target (mandatory)

Determine what behavior is being added or changed before touching any code.

Blocking output:

```text
TDD_TARGET
- behavior: "<what should happen>"
- test_file: "<path>"
- implementation_file: "<path>"
- scope: <unit|integration>
```

### Step 2: RED — write one failing test

Write exactly one test that demonstrates the desired behavior. The test must:

- call real code (not mocks, unless external dependency makes this unavoidable)
- assert the expected outcome
- not pass yet

Do not write implementation code in this step.

### Step 3: Verify RED (mandatory)

Run the test and confirm it fails for the right reason.

```bash
bun test <target> 2>&1
```

Right reason: the feature/behavior is missing or incorrect.
Wrong reason: typo, import error, missing fixture, syntax error.

If the test fails for the wrong reason, fix the test — not the implementation.
If the test passes immediately, the test is wrong or the behavior already exists. Investigate before proceeding.

Blocking output:

```text
TDD_CYCLE
- phase: RED
- test_name: "<test case>"
- command: "<exact run command>"
- expected_result: "test fails because behavior is not implemented"
- actual_result: "<observed output>"
```

### Step 4: GREEN — write minimal code

Write the smallest amount of production code that makes the failing test pass. No more.

Hard rules:

- Do not add behavior beyond what the test demands.
- Do not refactor during this step.
- Do not write additional tests during this step.

### Step 5: Verify GREEN (mandatory)

Run the test again and confirm it passes. Then run the broader suite to check for regressions.

```bash
bun test <target> 2>&1
bun test 2>&1
```

Blocking output:

```text
TDD_CYCLE
- phase: GREEN
- test_name: "<test case>"
- command: "<exact run command>"
- expected_result: "test passes"
- actual_result: "<observed output>"
```

If the test still fails, fix the implementation — do not weaken the test.
If other tests regress, fix regressions before continuing.

### Step 6: REFACTOR — clean up while green

With all tests passing, improve code quality:

- remove duplication
- improve naming
- simplify structure

Run the full suite after refactoring:

```bash
bun test 2>&1
```

Blocking output:

```text
TDD_CYCLE
- phase: REFACTOR
- test_name: "<all tests>"
- command: "<exact run command>"
- expected_result: "all tests still pass"
- actual_result: "<observed output>"
```

If any test fails during refactor, revert the refactor change immediately.

### Step 7: Repeat cycle

Return to Step 1 for the next behavior increment. Each cycle adds exactly one tested behavior.

### Step 8: Emit TDD report

After all cycles are complete:

```text
TDD_REPORT
- cycles_completed: <N>
- tests_added:
  - "<test name + behavior>"
- implementation_summary: "<what changed>"
- all_tests_pass: <yes|no>
- regression_check: <pass|fail|skip>
```

## Code Before Test? Delete It.

If you wrote production code before writing a failing test:

1. Delete it.
2. Start over from Step 1.

No exceptions:

- Don't keep it as "reference".
- Don't "adapt" it while writing tests.
- Delete means delete.

## Bug Fix Integration

Bug found? Follow TDD:

1. Write a failing test that reproduces the bug.
2. Verify it fails (RED).
3. Fix the bug with minimal code (GREEN).
4. Refactor if needed.
5. Confirm the reproducing test now passes and no regressions exist.

## Good Test Qualities

| Quality      | Description                                                     |
| ------------ | --------------------------------------------------------------- |
| Minimal      | Tests one behavior, not multiple concerns.                      |
| Clear        | Test name describes expected behavior in plain language.        |
| Shows intent | Reader understands what is being tested without reading source. |
| Real code    | Calls actual implementation, not mocks (unless unavoidable).    |

## Anti-Rationalization

### Red Flags

- You wrote code before writing a test.
- A new test passes immediately without implementation change.
- You are rationalizing "just this once" or "I'll add the test after".
- You believe the code is "too simple to test".
- You are keeping deleted code as "reference".
- You are weakening a test assertion to make it pass.

### Common Rationalizations

| Rationalization                         | Why it's wrong                                                        |
| --------------------------------------- | --------------------------------------------------------------------- |
| "It's too simple to need a test."       | Simple code has simple tests. No excuse to skip.                      |
| "I'll write the test after."            | Then you can't verify the test catches the right failure.             |
| "I tested it manually."                 | Manual testing is not repeatable and will not catch regressions.      |
| "I already wrote the code, why delete?" | Sunk cost. The code is untested — you don't know if tests cover it.   |
| "The spirit of TDD is what matters."    | Violating the letter is violating the spirit. Process is the point.   |
| "TDD is too slow for this."             | TDD is slower per-line but faster per-bug. Pay now or pay more later. |
| "Mocks are fine for everything."        | Mocks test your assumptions, not behavior. Use real code.             |
| "I'll just refactor while going green." | GREEN is for minimal pass. REFACTOR is a separate step.               |

## Stop Conditions

- Test infrastructure does not exist and cannot be bootstrapped in budget.
- Design is too unclear to define a single testable behavior.
- Tool-call budget exceeds configured limit without completing a cycle.
- Required test runner or environment is unavailable.

When stopping, provide:

1. what was completed (cycles finished, tests written)
2. what blocked further progress
3. recommended next step or skill escalation

## Anti-Patterns (never)

- Writing production code before a failing test.
- Weakening test assertions to achieve green.
- Skipping the RED verification step.
- Combining multiple behaviors in a single test.
- Refactoring during the GREEN step.
- Claiming TDD compliance without running tests.
- Keeping "reference" implementation code written before tests.

## Example

Input:

```text
"Add a cooldown check to the schedule service that rejects tasks submitted within 30 seconds of the last run."
```

Expected workflow:

1. Identify target: schedule service cooldown behavior, unit scope.
2. Write test: call schedule with two tasks 10 seconds apart, assert second is rejected.
3. Verify RED: test fails because cooldown logic does not exist.
4. Write minimal cooldown check in schedule service.
5. Verify GREEN: test passes, no regressions.
6. Refactor if needed while keeping green.
7. Emit `TDD_REPORT` with cycle count and evidence.
