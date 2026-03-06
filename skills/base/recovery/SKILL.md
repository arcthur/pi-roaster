---
name: recovery
description: Evidence-driven bounded recovery skill for stalled or misaligned execution. Use when a loop or active skill is blocked by repeated failures, convergence guard pressure, or plan-reality mismatch and needs a concrete next move.
stability: experimental
tools:
  required: [read, grep]
  optional:
    - ledger_query
    - output_search
    - task_view_state
    - task_record_blocker
    - task_resolve_blocker
    - skill_route_override
    - skill_complete
  denied: []
budget:
  max_tool_calls: 60
  max_tokens: 120000
outputs: [recovery_plan, blocker_evidence, next_skill_hint]
consumes: [iteration_report, failure_evidence, current_plan, constraints]
composable_with: [goal-loop, planning, debugging, verification]
---

# Recovery Skill

## Intent

Recover from stalled execution through evidence, not open-ended self-reflection.

This skill exists for unhappy-path handling:

- repeated failures
- convergence guard pressure
- plan-reality mismatch
- missing or contradictory evidence
- blocked progress inside `goal-loop` or another active skill

## Reference Map

Read [references/blocker-matrix.md](references/blocker-matrix.md)
when blocker classification or recovery mode selection is ambiguous.

Read [references/evidence-sources.md](references/evidence-sources.md)
when the blocker packet is weak and you need better evidence before deciding.

## The Iron Law

```text
NO OPEN-ENDED RECOVERY LOOPS
```

Recovery must end with one of:

- a concrete `recovery_plan`
- a validated blocker record
- a handoff to a better-fit skill

If you are only producing more speculation, recovery has failed.

## Trigger

Use this skill when any of the following is true:

- `scan_convergence_armed` or similar guard pressure indicates low-signal investigation drift
- two or more consecutive attempts fail without new evidence
- the current plan no longer matches observed system state
- the active loop cannot determine whether to continue or stop

Do not use this skill when:

- there is no failure or blockage signal
- the task is simply incomplete but still making clean forward progress
- the correct next step is obviously `verification`

## Step 1: Capture Blocker Evidence (mandatory)

Collect the minimum evidence needed to explain why progress stopped.

Preferred sources:

- latest `iteration_report`
- failure output or task ledger blocker state
- ledger/tape/output artifacts already produced by the run
- explicit runtime guard or scheduling signals

If evidence quality is weak, load [references/evidence-sources.md](references/evidence-sources.md)
before classifying the blocker.

Blocking output:

```text
BLOCKER_EVIDENCE
- blocker_type: <repeated_failure|plan_mismatch|evidence_gap|external_blocker|invalid_goal_contract>
- signals:
  - "<observable signal>"
- affected_scope:
  - "<task, file, module, or loop>"
- confidence: <high|medium|low>
```

## Step 2: Classify the Recovery Path

Choose the narrowest recovery mode that can restore progress.

Allowed modes:

- `RESUME_WITH_PATCH`: current path is still valid; only a small correction is needed
- `SWITCH_TO_DEBUGGING`: a root cause must be confirmed before more execution
- `SWITCH_TO_PLANNING`: the current plan is no longer decision-complete
- `SWITCH_TO_VERIFICATION`: the work may already be done; proof is missing
- `WAIT_FOR_INPUT`: progress is blocked by missing external facts or user intent
- `ABORT_LOOP`: the loop contract is invalid or unsafe to continue

If mode choice is unclear, load [references/blocker-matrix.md](references/blocker-matrix.md)
before emitting `RECOVERY_CLASSIFICATION`.

Blocking output:

```text
RECOVERY_CLASSIFICATION
- mode: <RESUME_WITH_PATCH|SWITCH_TO_DEBUGGING|SWITCH_TO_PLANNING|SWITCH_TO_VERIFICATION|WAIT_FOR_INPUT|ABORT_LOOP>
- why: "<why this is the narrowest valid recovery>"
- discarded_modes:
  - "<mode + reason>"
```

## Step 3: Produce a Bounded Recovery Plan

Recovery plans must be short and executable.

Rules:

- maximum 3 steps
- each step must produce new evidence or unblock a concrete path
- no "think again" or "reconsider broadly" instructions
- if the blocker is external, say so explicitly instead of inventing work

Required output:

```text
RECOVERY_PLAN
- mode: <same as classification>
- steps:
  - "<step 1>"
  - "<step 2>"
  - "<step 3 if needed>"
- success_signal:
  - "<what would prove recovery worked>"
```

## Step 4: Record or Resolve Blockers

When task ledger tools are available:

- record blockers that are durable and externally relevant
- resolve blockers only when new evidence actually clears them

Avoid turning transient confusion into permanent blocker noise.

## Step 5: Hand Off Cleanly

Recovery does not own the entire remaining task.
It should point to the next best skill explicitly.

Required output:

```text
NEXT_SKILL_HINT
- target: <goal-loop|planning|debugging|verification|execution>
- reason: "<why this skill should own the next step>"
- carry_forward:
  - "<evidence or decision to preserve>"
```

## Stop Conditions

- a concrete recovery plan is emitted
- a durable external blocker is confirmed
- the next owning skill is unambiguous
- recovery budget is exhausted without new evidence

If recovery budget is exhausted, stop and report the missing evidence rather than looping.

## Escalation

- hand off to `debugging` for root-cause isolation
- hand off to `planning` for contract or scope redesign
- hand off to `verification` when the main uncertainty is proof, not implementation
- hand off back to `goal-loop` once a valid recovery plan exists

## Anti-Patterns

- speculative self-reflection without evidence
- broad rewrite plans inside recovery
- masking a missing external dependency as an internal blocker
- continuing a loop after repeated no-progress turns without changing strategy
