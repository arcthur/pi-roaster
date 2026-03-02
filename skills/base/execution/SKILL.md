---
name: execution
description: Dispatch and coordinate plan execution via subagents, batched steps, or parallel domains. Use when you have an approved implementation plan with discrete tasks ready for execution.
version: 1.0.0
stability: stable
tier: base
tags: [execute, dispatch, subagent, batch, parallel, orchestration]
anti_tags: [explore, plan]
triggers:
  intents: ["execute plan", "dispatch tasks", "parallelize execution", "run implementation plan"]
  topics: ["execution steps", "subagent", "batching", "orchestration"]
  phrases: ["execute plan", "parallel execution"]
tools:
  required: [read, exec]
  optional: [grep, edit, skill_complete]
  denied: []
budget:
  max_tool_calls: 100
  max_tokens: 200000
outputs:
  [
    boundary_decision,
    action_mode,
    execution_mode,
    task_dispatch,
    execution_progress,
    review_gate,
    execution_report,
  ]
consumes: [execution_steps, design_spec, handoff_packet]
escalation_path:
  plan_unclear: planning
  repeated_task_failure: debugging
---

# Execution Skill

## Intent

Execute implementation plans through coordinated task dispatch with review gates, ensuring quality through fresh-context execution and multi-stage verification.

## Trigger

Use this skill when you have an approved implementation plan with discrete tasks ready for execution.

Skip this skill when:

- No plan exists yet (use `planning` first).
- The task is a single-file fix with no coordination need (use `patching` directly).
- You need to explore the system before acting (use `exploration`).

## Step 0: Autonomy Boundary Gate (mandatory first step)

Choose action mode before task dispatch:

- `ACT_DIRECT`: read-only actions or reversible local edits
- `ACT_WITH_NOTICE`: broader but non-destructive actions
- `ASK_FIRST`: destructive or hard-to-rollback actions, or high-impact API/persistence changes

Blocking output:

```text
BOUNDARY_DECISION
- action: <ACT_DIRECT|ACT_WITH_NOTICE|ASK_FIRST>
- risk_class: <A|B|C>
- rationale: "<risk-based reason>"
- next_step: "<execute|notify|ask>"
```

Hard rules:

- `ASK_FIRST` requires explicit user confirmation before execution.
- boundary gate controls act-vs-ask; it does not replace planning decisions.

## Step 1: Mode Detection (mandatory)

Before executing anything, classify the execution mode.

| Pattern                            | Mode     | Goal                                          |
| ---------------------------------- | -------- | --------------------------------------------- |
| Independent tasks, same session    | SUBAGENT | Fresh subagent per task + two-stage review    |
| Batch tasks, checkpoint review     | BATCH    | Execute in batches of 3, human review between |
| Independent domains, parallel safe | PARALLEL | One agent per problem domain, concurrent      |

Decision tree:

```text
Are all tasks independent (no shared files)?
├─ YES
│   ├─ Can tasks run concurrently without conflict?
│   │   ├─ YES → PARALLEL
│   │   └─ NO → SUBAGENT
│   └─ Is human checkpoint review needed between groups?
│       └─ YES → BATCH
└─ NO
    ├─ Are tasks naturally grouped in small batches?
    │   └─ YES → BATCH
    └─ NO → SUBAGENT (sequential)
```

Blocking output:

```text
EXECUTION_MODE
- mode: <SUBAGENT|BATCH|PARALLEL>
- plan_source: "<path>"
- total_tasks: <N>
- rationale: "<why this mode>"
```

## SUBAGENT Mode

### Step 1: Load plan and extract tasks

Read the plan source. Extract every task with its full text, scope, and dependencies.

For each task, emit:

```text
TASK_DISPATCH
- task_id: <N>
- description: "<what>"
- scope: ["<file>"]
- context: "<essential context>"
- constraints: ["<constraint>"]
- expected_output: "<what agent should return>"
```

### Step 2: Per-task execution cycle

For each task in dependency order:

1. **Dispatch implementer**: execute the task in a fresh context with only the scoped files and constraints.
2. **Spec review**: verify the implementation matches the plan's acceptance criteria.
3. **Quality review**: check code quality, style consistency, and absence of regressions.
4. **Mark complete**: update progress tracking.

After each task, emit:

```text
REVIEW_GATE
- task: <N>
- spec_compliance: <pass|fail>
- spec_gaps: ["<gap>"]
- quality_check: <pass|fail>
- quality_issues: ["<issue>"]
- verdict: <proceed|fix|escalate>
```

If verdict is `fix`, retry the task once with issues as additional constraints.
If verdict is `escalate`, stop and report the blocking issue.

### Step 3: Final review and finishing

After all tasks complete:

1. Run full verification (typecheck, tests, lint).
2. Emit execution report.
3. Transition to finishing flow (git, cleanup).

## BATCH Mode

### Step 1: Load and critically review plan

Read the plan. Validate that tasks are correctly scoped and ordered. Challenge any task that seems under-specified.

### Step 2: Execute batch (default size: 3)

Execute the next batch of up to 3 tasks sequentially. For each task, apply the same dispatch/review cycle as SUBAGENT Step 2.

### Step 3: Report and wait for feedback

After each batch, emit `EXECUTION_PROGRESS` and pause for human review.

```text
EXECUTION_PROGRESS
- completed:
  - task: <N>
    status: <pass|fail>
    summary: "<what was done>"
- in_progress:
  - task: <N>
- remaining:
  - task: <N>
- blockers:
  - "<blocker>"
```

Do not proceed to the next batch until feedback is received or explicit approval is given.

### Step 4: Continue until complete

Repeat Steps 2-3 until all tasks are done, then run final verification.

## PARALLEL Mode

### Step 1: Identify independent problem domains

Group tasks by problem domain. Verify no file overlap between domains.

### Step 2: Dispatch one agent per domain

Each agent receives:

- Its domain's task list with full context.
- Explicit file boundaries (must not touch files outside scope).
- Expected outputs and acceptance criteria.

Emit `TASK_DISPATCH` for each domain agent.

### Step 3: Review and integrate results

Collect results from all domain agents. Review each for spec compliance and quality. Resolve any integration conflicts at domain boundaries.

### Step 4: Run full verification

After integration, run the complete verification suite across all changed files.

## Final Output (all modes)

Every execution must conclude with:

```text
EXECUTION_REPORT
- plan: "<source>"
- tasks_completed: <N/M>
- verification: <pass|partial|fail>
- evidence:
  - "<command + result>"
- next_step: "<recommendation>"
```

## Stop Conditions

- Plan source is missing or unreadable.
- A task fails review twice (dispatch + one retry).
- Multiple tasks target the same files with conflicting changes.
- Verification fails after all tasks complete and root cause is unclear.
- Budget is exhausted before completion.

When stopped, emit `EXECUTION_REPORT` with partial results and the specific blocker.

## Anti-Patterns (never)

- Skipping review gates (spec compliance or code quality) for any task.
- Dispatching multiple implementation agents to overlapping file sets.
- Proceeding past a failed review gate without fixing or escalating.
- Starting implementation on main/master without explicit consent.
- Allowing an implementer to self-review in place of actual review.
- Executing without a plan (use `planning` skill first).
- Ignoring dependency order between tasks.
- Treating partial verification as full pass.

## Example

Input:

```text
"Execute the approved plan at docs/plans/migrate-gate.md"
```

Expected flow:

1. Read plan, extract 5 tasks, detect SUBAGENT mode (independent tasks, same session).
2. `EXECUTION_MODE`: SUBAGENT, 5 tasks, rationale.
3. Per task: `TASK_DISPATCH` → implement → `REVIEW_GATE` (spec + quality).
4. `EXECUTION_PROGRESS` after each task.
5. Final verification: typecheck, tests, lint.
6. `EXECUTION_REPORT`: 5/5 completed, verification pass, evidence, next step.
