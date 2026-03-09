# Repair Loop Protocol

## Intent

The repair loop exists only for known, local contract failures.

It is not an open-ended retry policy and it is not a prompt to reconsider the entire task.

## Entry Rule

Enter repair only when all conditions are met:

- the validator returned a concrete failure category
- the failing field or section can be localized
- repair budget remains greater than zero

If the failure is vague, do not retry. Escalate as `blocked` or hand off instead.

## Attempt Budget

The default repair budget should be at most 3 attempts.

A smaller default is preferable when it still covers obvious schema and invariant corrections.

Every attempt must:

- narrow scope
- identify the exact target field or section
- record a diagnostic

## Diagnostic Format

Emit a diagnostic block before each repair attempt:

```text
REPAIR_DIAGNOSTIC
- attempt: <N>
- failure_type: <schema_mismatch|invariant_violation|parse_error|timeout|tool_failure>
- failing_fields:
  - field: "<path>"
    expected: "<constraint>"
    actual: "<value>"
- repair_strategy: "<what to change next>"
```

## Narrowing Strategy

Repair must be narrower than the original execution step.

Priority order:

1. fix only failing fields
2. retry only the failing section
3. adjust only the canonicalization needed to resolve the failure

Do not:

- rerun the entire extraction without explaining the narrower scope
- retry the same failure unchanged
- expand scope during repair

## Exit Rules

Repair ends when any of the following occurs:

- the validator passes
- the budget is exhausted
- the same structural failure repeats twice
- the validator path itself is unavailable

Final status mapping:

- first-pass validation success -> `zca_result.status=validated`
- repaired validation success -> `zca_result.status=repaired`
- budget exhausted -> `zca_result.status=exhausted`
- validator unavailable or repeated structural failure -> `zca_result.status=blocked`

## Final Repair Summary

At completion time, fold the history into:

```text
ZCA_REPAIR
- total_attempts: <N>
- outcome: <not_needed|repaired|exhausted|blocked|repeated_failure>
- last_diagnostic: "<why the loop ended>"
```

The success path must still populate this block:

- first-pass success -> `outcome=not_needed`
- repaired success -> `outcome=repaired`

## Handoff Guidance

Prefer handoff to `recovery` when:

- the repair budget is exhausted
- the validator command path is unavailable
- the root cause is the contract itself rather than a local field

Prefer handoff to `planning` when:

- the schema does not match the real task goal
- projection cannot be stabilized

## Anti-Patterns

- retrying without a diagnosis
- repeating the same failure state
- using repair to hide a bad contract design
- continuing retries after the budget is exhausted

