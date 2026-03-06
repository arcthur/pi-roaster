---
name: goal-loop
description: Runtime-native iterative delivery skill for goals that require repeated scheduled execution until explicit convergence. Use when a task needs multi-run progress, bounded continuity, and auditable stop conditions rather than a single-session push.
stability: experimental
tools:
  required: [read]
  optional:
    - grep
    - schedule_intent
    - task_view_state
    - ledger_query
    - skill_load
    - skill_chain_control
    - skill_complete
  denied: []
budget:
  max_tool_calls: 70
  max_tokens: 140000
outputs:
  [loop_intent, iteration_report, convergence_evidence, delivery_summary, loop_handoff]
consumes: [goal_statement, constraints, completion_contract, available_skills]
composable_with: [planning, execution, verification, recovery]
---

# Goal Loop Pack Skill

## Intent

Declare and manage a convergent multi-run goal using Brewva's runtime scheduling primitives.

This skill is for happy-path autonomous progress:

- define a goal that cannot be completed reliably in one turn
- encode runtime-native convergence conditions
- delegate each run to the right execution skill(s)
- produce auditable iteration artifacts until the goal converges or exits

## Reference Map

Read [references/convergence-patterns.md](references/convergence-patterns.md)
when mapping a goal into `convergenceCondition`, `maxRuns`, and delay-vs-cron cadence.

Read [references/handoff-patterns.md](references/handoff-patterns.md)
when the delegated skill chain or `LOOP_HANDOFF` target is unclear.

## Core Boundary

This skill must not simulate repetition in prose.

Responsibility split:

- **runtime owns**: wakeups, child-session creation, continuity, `maxRuns`, convergence evaluation, retry/circuit behavior, and schedule projection recovery
- **goal-loop owns**: goal contract, convergence mapping, cadence choice, delegated skill sequencing, per-run reporting, and recovery handoff

If you catch yourself writing "keep trying until done" without encoding a runtime intent, stop and use `schedule_intent`.

## Trigger

Use this skill when:

- the user declares a compound objective that needs repeated progress over time
- completion depends on iterative evidence gathering, execution, and re-checking
- daemon-managed continuity is preferable to keeping one long interactive session open
- progress must remain replayable and observable through schedule artifacts

Do not use this skill when:

- the task is expected to complete in one normal execution pass
- the user only wants brainstorming or initial scoping
- convergence cannot be expressed through observable runtime signals

## Step 0: Loop Viability Gate (mandatory)

Before scheduling anything, confirm the loop is worth creating.

Required inputs:

- one clear goal statement
- one explicit completion contract
- one bounded schedule target (delay or cron)
- one named failure/recovery path

Blocking output:

```text
LOOP_VIABILITY
- decision: <schedule|do_not_schedule>
- goal: "<single durable objective>"
- completion_contract:
  - "<observable completion signal>"
- schedule_target: "<delay or cron>"
- recovery_path: "<recovery|debugging|planning>"
- rationale: "<why looping is justified>"
```

If `decision=do_not_schedule`, hand off to `planning`, `execution`, or `verification` instead.

## Step 1: Declare the Loop Contract

Translate the user objective into a runtime-facing contract.

Required fields:

- `goal_statement`: the durable objective
- `continuityMode`: default to `inherit`; use `fresh` only when each run should ignore prior task state
- `maxRuns`: finite budget, never "infinite"
- delegated skill path for each run
- explicit recovery handoff when progress stalls

Blocking output:

```text
LOOP_CONTRACT
- goal_statement: "<durable objective>"
- continuity_mode: <inherit|fresh>
- max_runs: <N>
- delegated_flow:
  - "<skill + purpose>"
- recovery_handoff: "<when to load recovery>"
```

## Step 2: Encode Convergence with Runtime-Native Predicates

Map the completion contract to supported `convergenceCondition` predicates:

- `truth_resolved`
- `task_phase`
- `max_runs`
- `all_of`
- `any_of`

Rules:

- prefer `task_phase=done` when the task ledger is the source of truth
- use `truth_resolved` for fact-style completion
- use `all_of` / `any_of` only to compose already-observable predicates
- never encode subjective "feels done" criteria

If predicate choice is unclear, load [references/convergence-patterns.md](references/convergence-patterns.md)
before creating the intent.

Required output:

```text
LOOP_INTENT
- reason: "<why this intent exists>"
- continuityMode: <inherit|fresh>
- maxRuns: <N>
- convergenceCondition: "<structured predicate summary>"
- schedule_target:
  - type: <delay|cron>
  - value: "<target>"
```

## Step 3: Create or Update Runtime Intent

Use `schedule_intent` to create or update the loop.

Rules:

- create a new intent only when no active intent already owns the goal
- prefer `update` over duplicates when the goal already has an active schedule
- keep intent reasons stable and concise
- do not hide schedule decisions inside free-form prose

## Step 4: Per-Run Execution Discipline

On each wakeup, operate in bounded slices:

1. inspect the latest `iteration_report`, task state, and relevant evidence
2. run one meaningful progress step through delegated skills
3. emit a fresh `iteration_report`
4. decide one of: continue, converge, or hand off to `recovery`

Each run must end with:

```text
ITERATION_REPORT
- run: <N>
- objective_slice: "<what this run attempted>"
- actions:
  - "<skill or operation>"
- evidence:
  - "<observable result>"
- status: <progress|blocked|converged>
- next_step: "<next scheduled action or handoff>"
```

## Step 5: Handoff and Exit

When the loop can no longer make clean progress:

- load `recovery` if there is plan-reality mismatch, repeated failure, or convergence guard pressure
- load `verification` when the main question is "can we now prove completion?"
- cancel or let runtime converge the schedule once exit criteria are met

If next ownership is unclear, load [references/handoff-patterns.md](references/handoff-patterns.md)
before emitting `LOOP_HANDOFF`.

Successful loop completion must emit:

```text
CONVERGENCE_EVIDENCE
- signals:
  - "<predicate satisfied>"
- supporting_artifacts:
  - "<task, truth, ledger, or output evidence>"
- verdict: <converged|max_runs_reached|aborted>
```

```text
DELIVERY_SUMMARY
- outcome: "<what was achieved>"
- final_state: "<done|partial|aborted>"
- residual_work:
  - "<follow-up item>"
```

If the loop must hand off instead of exiting, emit:

```text
LOOP_HANDOFF
- target_skill: "<recovery|planning|debugging|verification>"
- reason: "<why goal-loop should stop owning the next step>"
- carry_forward:
  - "<artifact or evidence>"
```

## Stop Conditions

- convergence condition is satisfied
- `maxRuns` is reached
- the user explicitly aborts the goal
- recovery determines the goal contract is invalid or blocked by missing external input
- runtime opens the schedule circuit due to repeated errors

## Escalation

- hand off to `planning` when the goal contract is under-specified
- hand off to `recovery` when repeated progress attempts stop producing new evidence
- hand off to `verification` before making completion claims

## Anti-Patterns

- using narrative repetition instead of `schedule_intent`
- creating a loop without a bounded `maxRuns`
- defining convergence through subjective judgment
- letting one wakeup session perform unbounded work
- mixing happy-path progress and unhappy-path recovery into the same output contract
