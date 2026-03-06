# Handoff Patterns Reference

Load this reference when `goal-loop` is unsure which skill should own the next
step of a run or how to carry artifacts across the cascade boundary.

## Owner Selection Matrix

| Situation | Next owner | Carry forward | Why |
| --- | --- | --- | --- |
| Goal contract is still fuzzy | `planning` | goal statement, constraints, failed contract draft | Loop should not own design ambiguity |
| Plan exists and the next run is straightforward work | `execution` | current run objective, scoped task items | Keep happy-path work in execution-oriented skills |
| Main question is whether the work is now proven | `verification` | files changed, claimed success signal, prior evidence | Avoid mixing proof with progress |
| Repeated failures or no new evidence | `recovery` | latest iteration report, failure evidence, current plan | Switch from forward motion to bounded recovery |
| A root cause must be isolated before more edits | `debugging` | failing command, error output, hot path | Recovery should not impersonate debugging |

## Canonical Cascades

### Delivery-first loop

```text
goal-loop -> planning -> execution -> verification -> goal-loop
```

Use when the loop repeatedly refines and ships bounded chunks.

### Failure-contained loop

```text
goal-loop -> recovery -> debugging -> recovery -> goal-loop
```

Use when the loop encounters a concrete failure and should return only after a valid recovery path exists.

### Contract repair loop

```text
goal-loop -> recovery -> planning -> goal-loop
```

Use when the blocker is a bad goal contract rather than an implementation bug.

## Minimum Carry-Forward Packet

Every `LOOP_HANDOFF` should preserve:

- current run number
- objective slice attempted
- latest evidence or failure signal
- current convergence condition
- explicit reason for handoff

Suggested shape:

```text
LOOP_HANDOFF
- target_skill: "<skill>"
- reason: "<handoff trigger>"
- carry_forward:
  - "run=<N>"
  - "objective_slice=<what was attempted>"
  - "evidence=<latest result>"
  - "convergence=<current predicate>"
```

## Return Criteria Back to `goal-loop`

`goal-loop` should resume ownership only when at least one of these is true:

- a new executable plan exists
- a blocker has been resolved with fresh evidence
- a narrower next step is defined and still serves the original loop goal

If none are true, stay in the owning skill instead of bouncing ownership back prematurely.

## Anti-Patterns

- handing off to `recovery` with no concrete failure signal
- handing off to `verification` before any explicit success claim exists
- using `goal-loop` as a generic container for unresolved planning work
- returning to `goal-loop` without changing evidence, plan, or ownership rationale
