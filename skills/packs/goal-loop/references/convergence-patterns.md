# Convergence Patterns Reference

Load this reference when `goal-loop` needs help turning a user objective into a
runtime-native `convergenceCondition` plus a schedule shape.

## Selection Heuristic

Pick the predicate from the system of record:

- use `task_phase` when task ledger state defines completion
- use `truth_resolved` when a fact or external condition defines completion
- use `all_of` when multiple observable gates must all pass
- use `any_of` when any one of several observable outcomes is sufficient
- use `max_runs` only as a hard safety rail, not as the business definition of done

## Common Goal Shapes

| Goal shape | Preferred predicate | Typical schedule bias | Notes |
| --- | --- | --- | --- |
| Deliver a multi-step task to done | `task_phase=done` | short delay or cron | Best default for iterative execution work |
| Wait for an external fact to become true | `truth_resolved` | cron | Use when completion lives outside the task ledger |
| Finish only after task state and verification are both satisfied | `all_of(...)` | short delay first, then cron if long-lived | Keeps "done" tied to observable evidence |
| Accept one of several valid terminal states | `any_of(...)` | cron | Use sparingly; terminal states must still be objective |

## Pattern Templates

### 1. Task-ledger delivery loop

Use when each run advances a durable task item.

```text
continuityMode: inherit
maxRuns: 12
convergenceCondition:
  kind: task_phase
  phase: done
schedule_target:
  type: delay
  value: 900000
```

Why:

- task state remains the source of truth
- inherited continuity preserves prior run context
- delay scheduling suits bounded active delivery

### 2. Fact-resolution watcher

Use when the work is mostly checking whether an external condition has changed.

```text
continuityMode: fresh
maxRuns: 48
convergenceCondition:
  kind: truth_resolved
  factId: release_window_open
schedule_target:
  type: cron
  value: "0 * * * *"
```

Why:

- `fresh` avoids carrying stale execution state into watch-style runs
- cron cadence matches periodic polling/checking behavior

### 3. Delivery plus proof

Use when execution is not enough and proof is part of completion.

```text
continuityMode: inherit
maxRuns: 10
convergenceCondition:
  kind: all_of
  predicates:
    - kind: task_phase
      phase: done
    - kind: truth_resolved
      factId: verification_green
schedule_target:
  type: delay
  value: 1800000
```

Why:

- task completion alone is not sufficient
- proof remains explicit and machine-checkable

## Schedule Choice Rules

- Prefer `delay` for active delivery loops expected to converge within hours.
- Prefer `cron` for watch/monitor/retry work that may span days.
- Use shorter cadence only when each wakeup does small bounded work.
- If one wakeup needs broad execution, fix the delegated flow instead of tightening cadence.

## Guardrails

- Do not encode subjective states such as "looks done" or "seems stable".
- Do not use `any_of` to hide ambiguity in the success definition.
- Do not use `max_runs` as the only convergence definition unless the goal is explicitly time-boxed.
- If no observable predicate fits the goal, route to `planning` and redesign the contract first.
