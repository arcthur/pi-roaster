---
name: compose
description: Use when task spans 2+ skill domains and output of one skill is a required input for another — single skill insufficient.
version: 1.0.0
stability: stable
tier: base
tags: [complex, multi-step, architecture, orchestration]
anti_tags: [quick-fix, trivial]
consumes: []
escalation_path:
  all_skills_insufficient: planning
tools:
  required: [read]
  optional: [grep, exec, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 40
  max_tokens: 100000
outputs: [compose_analysis, skill_sequence, compose_plan]
---

# Compose Skill

## Intent

Decompose complex requests into an ordered, dependency-aware sequence of skill invocations with explicit data contracts between them.

## Trigger

Use this skill when:

- Task spans 2+ skill domains (e.g., explore then plan then patch then verify).
- Output of one skill is a required input for another.
- Parallelization across independent subtasks is possible.
- User request is too broad for any single skill to resolve alone.

### Decision tree: compose vs single skill

```text
Is the task achievable by one skill invocation?
├─ YES → use that skill directly
└─ NO
   ├─ Are the subtasks independent (no shared data)?
   │   ├─ YES → compose with parallel lanes
   │   └─ NO → compose with sequential chain
   └─ Does no existing skill cover a subtask?
       └─ YES → escalate to planning (escalation_path)
```

Skip this skill for tasks where a single skill's workflow already covers all steps.

## Compose Workflow

### Step 1: Decompose the request (mandatory)

Break the user request into atomic subtasks. Each subtask must map to exactly one existing skill.

Identify for each subtask:

- which skill handles it
- what input it needs
- what output it produces
- whether it blocks downstream subtasks

Blocking output:

```text
COMPOSE_ANALYSIS
- request_summary: "<one-line distillation>"
- subtasks:
  - id: T1
    description: "<what>"
    skill: <skill_name>
    requires_input_from: []
    produces: ["<output_name>"]
  - id: T2
    description: "<what>"
    skill: <skill_name>
    requires_input_from: [T1]
    produces: ["<output_name>"]
```

Rules:

- Every subtask must map to a known skill. If no skill fits, stop and escalate.
- Keep subtask count minimal; do not fragment artificially.
- Mark data dependencies explicitly; do not assume implicit ordering.

### Step 2: Define inter-skill data contracts

For each dependency edge, specify exactly what data flows and in what format.

```text
DATA_CONTRACT
- from: T1.<output_name>
- to: T2
- shape: "<description of expected structure>"
- required_fields:
  - "<field>"
```

If a skill's documented outputs do not cover the required shape, note the gap as a risk.

### Step 3: Identify parallel opportunities

Group subtasks into execution lanes:

- **Sequential**: T*n depends on T*(n-1) output.
- **Parallel**: independent subtasks with no shared data dependency.

```text
EXECUTION_LANES
- lane_1: [T1, T3]          # sequential chain
- lane_2: [T2]              # independent, runs parallel to lane_1
- sync_point: after [T2, T3] # join before T4
- lane_3: [T4]              # continues after sync
```

Parallelization rules:

- Never parallelize skills that read and write overlapping file sets.
- Verification must always run after all patching completes.
- Git operations are always the final lane.

### Step 4: Plan failure handling

For each subtask, define behavior on stop/failure:

| Failure Mode                   | Response                                                             |
| ------------------------------ | -------------------------------------------------------------------- |
| Skill stops with missing input | Backtrack: re-run upstream skill with narrower scope                 |
| Skill produces partial output  | Assess: if downstream can proceed with partial, continue; else stop  |
| All skills insufficient        | Escalate to `planning` skill for strategy redesign                   |
| Budget exceeded mid-sequence   | Emit partial `COMPOSE_PLAN` with completed steps and remaining queue |

### Step 5: Emit final plan

Blocking output:

```text
SKILL_SEQUENCE
- step: 1
  skill: <skill_name>
  intent: "<what this invocation achieves>"
  inputs: ["<source>"]
  expected_outputs: ["<output_name>"]
  lane: <lane_id>
- step: 2
  skill: <skill_name>
  intent: "<what this invocation achieves>"
  inputs: ["T1.<output_name>"]
  expected_outputs: ["<output_name>"]
  lane: <lane_id>
```

Final blocking output:

```text
COMPOSE_PLAN
- total_steps: <N>
- parallel_lanes: <M>
- estimated_tool_budget: <sum of per-skill budgets>
- critical_path: [T1, T3, T4]
- risks:
  - "<risk description>"
- failure_strategy: "<backtrack|stop|escalate>"
```

## Stop Conditions

- A subtask maps to no existing skill and cannot be decomposed further.
- Circular dependency detected between subtasks.
- Total estimated budget exceeds system limits with no pruning path.

When blocked by unverifiable steps, emit `TOOL_BRIDGE` using
`skills/base/planning/references/executable-evidence-bridge.md` and assign the bridge to the appropriate downstream skill.

On stop, report the blocking subtask and recommend escalation target.

## Anti-Patterns (never)

- Invoking compose for single-skill tasks.
- Creating subtasks that duplicate work across skills.
- Omitting data contracts and hoping skills "just connect."
- Parallelizing skills with overlapping write targets.
- Skipping failure handling because "it will probably work."
- Executing changes directly; compose only plans, never patches.

## Example

Input:

```text
"Refactor the verification gate to use command-backed checks, update tests, and commit."
```

Expected outputs:

1. `COMPOSE_ANALYSIS`: 5 subtasks — exploration, planning, patching (×2: gate + tests), verification, git.
2. `DATA_CONTRACT`: exploration map feeds planning; plan feeds patching inputs.
3. `EXECUTION_LANES`: exploration → planning → [patch-gate ∥ patch-tests] → verification → git.
4. `SKILL_SEQUENCE`: ordered steps with lane assignments.
5. `COMPOSE_PLAN`: 5 steps, 2 parallel lanes, critical path, risks, backtrack strategy.
