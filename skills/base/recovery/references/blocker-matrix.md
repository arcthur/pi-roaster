# Blocker Matrix Reference

Load this reference when `recovery` needs help classifying a stall signal into a
bounded recovery mode.

## Signal-to-Mode Matrix

| Primary signal                                               | Blocker type                          | Preferred recovery mode                       | Next owner                 |
| ------------------------------------------------------------ | ------------------------------------- | --------------------------------------------- | -------------------------- |
| `scan_convergence_armed` after low-signal searching          | `evidence_gap`                        | `SWITCH_TO_PLANNING` or `SWITCH_TO_DEBUGGING` | `planning` or `debugging`  |
| Same command/path fails repeatedly with the same first error | `repeated_failure`                    | `SWITCH_TO_DEBUGGING`                         | `debugging`                |
| Current task state contradicts the supposed plan             | `plan_mismatch`                       | `SWITCH_TO_PLANNING`                          | `planning`                 |
| External dependency or approval is missing                   | `external_blocker`                    | `WAIT_FOR_INPUT`                              | user or upstream system    |
| Work may already be complete but proof is absent             | `evidence_gap`                        | `SWITCH_TO_VERIFICATION`                      | `verification`             |
| Loop contract cannot be expressed safely anymore             | `invalid_goal_contract`               | `ABORT_LOOP`                                  | `goal-loop` terminates     |
| Small local correction should restore forward motion         | `plan_mismatch` or `repeated_failure` | `RESUME_WITH_PATCH`                           | `execution` or `goal-loop` |

## Tiebreakers

When two modes seem plausible:

1. prefer the narrower owner
2. prefer the mode that produces fresh evidence fastest
3. prefer `WAIT_FOR_INPUT` over inventing speculative internal work
4. prefer `ABORT_LOOP` over silently continuing an invalid contract

## Fast Checks

Ask these in order:

1. Is there a concrete failing signal?
2. Does the signal point to bad implementation or bad plan?
3. Is the blocker internal, external, or proof-related?
4. Can one bounded step create new evidence?

If the answer to step 4 is "no", do not keep iterating inside `recovery`.

## Red Flags

- classifying a missing requirement as a debugging problem
- using `RESUME_WITH_PATCH` for multi-file redesign
- choosing `SWITCH_TO_PLANNING` when the issue is plainly a reproducible bug
- choosing `SWITCH_TO_DEBUGGING` when no failure has been reproduced
