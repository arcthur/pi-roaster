---
name: brainstorming
description: Use when creating features, building components, adding functionality, or modifying behavior — before any implementation skill.
version: 1.0.0
stability: stable
tier: base
tags: [design, ideation, pre-implementation, feature-scoping]
anti_tags: [quick-fix, hotfix, typo]
tools:
  required: [read, grep]
  optional: [glob, ledger_query, skill_complete]
  denied: [write, edit, exec]
budget:
  max_tool_calls: 50
  max_tokens: 110000
outputs: [design_context, approach_options, design_spec]
consumes: [architecture_map, tree_summary]
escalation_path:
  scope_too_large: planning
  all_approaches_violate_constraints: review
---

# Brainstorming Skill

## Intent

Turn rough ideas into validated designs through collaborative dialogue before any code is written.

## Trigger

Use this skill when the task involves:

- creating a new feature or component
- adding or changing functionality
- modifying behavior across modules
- any work that benefits from design exploration before implementation

Skip this skill only for trivial one-liner fixes with zero design ambiguity (Step 0 decides).

## Iron Law

**NO IMPLEMENTATION WITHOUT DESIGN APPROVAL FIRST.**

Do NOT invoke any implementation skill, write any code, create any file, or take any implementation action until the design spec is presented to the user and explicitly approved.

## Anti-Pattern: "Too Simple"

Every project goes through this process. Simple projects are where unexamined assumptions cause the most waste. If the task looks trivial, that is a signal to verify assumptions — not to skip design.

## Brainstorming Workflow

### Step 0: Scope Guard (mandatory)

Before entering the design loop, challenge whether the task truly needs design exploration.

Skip criteria (all must be true):

- single file, single function change
- no API or contract change
- no ambiguity in behavior
- no alternative approaches worth comparing

If all skip criteria are met, state explicitly why design is unnecessary and hand off directly.

If any criterion fails, proceed to Step 1.

### Step 1: Context Gathering

Inspect the current state of the system relevant to the request:

1. Read related source files and module boundaries.
2. Check docs, config schemas, and type contracts.
3. Inspect recent commits touching the affected area.

Required output:

```text
DESIGN_CONTEXT
- project_state: "<current relevant state>"
- related_modules:
  - "<module + role>"
- constraints:
  - "<constraint>"
```

### Step 2: Clarifying Questions (max 5)

Ask clarifying questions one at a time. Each question must:

- target a decision that materially changes the design
- prefer multiple-choice format when possible
- include a default assumption if the user does not answer

Question policy:

- ask at most 5 questions total
- stop early when remaining uncertainty is low-risk
- proceed with explicit assumptions for low-impact unknowns

Template:

```text
CLARIFY_Q1: "<question>"
OPTIONS:
  a) "<choice>"
  b) "<choice>"
  c) "<choice>"
WHY_IT_MATTERS: "<design decision impacted>"
DEFAULT_IF_NO_ANSWER: "<assumption>"
```

### Step 3: Approach Options (2-3)

Propose 2-3 distinct approaches with trade-offs. Avoid presenting options that are effectively identical.

Each option must include:

- approach summary
- pros
- cons
- recommendation (yes/no with rationale)

Required output:

```text
APPROACH_OPTIONS
- option_a:
    summary: "<approach>"
    pros:
      - "<point>"
    cons:
      - "<point>"
    recommendation: <yes|no>
    rationale: "<why recommended or not>"
- option_b:
    summary: "<approach>"
    pros:
      - "<point>"
    cons:
      - "<point>"
    recommendation: <yes|no>
    rationale: "<why recommended or not>"
```

### Step 4: Present Design (section-by-section)

Present the design in sections scaled to complexity:

- **Small scope** (1-3 files): objective, components, scope boundary.
- **Medium scope** (4-8 files): add architecture, data flow, error handling.
- **Large scope** (>8 files): full design spec with testing strategy.

Get explicit approval per section before proceeding to the next. If the user rejects a section, revise before continuing.

### Step 5: Emit Design Spec (blocking output)

Once all sections are approved, emit the consolidated design spec.

Required output:

```text
DESIGN_SPEC
- objective: "<single sentence>"
- architecture: "<2-3 sentences>"
- components:
  - "<component + responsibility>"
- data_flow: "<A -> B -> C>"
- error_handling: "<strategy>"
- testing_strategy: "<approach>"
- scope_boundary:
  - in:
    - "<item>"
  - out:
    - "<item>"
- approval_status: <approved|pending|rejected>
```

`approval_status` must be `approved` before any downstream skill is invoked.

### Step 6: Transition to Planning

After approval, hand off to the planning skill with the design spec as input.

Handoff boundary:

- execution planning => `planning`
- system-level unknowns discovered => `exploration`
- constraint violations across all approaches => `review`

## Stop Conditions

- Task has zero design ambiguity (all Step 0 skip criteria met).
- User explicitly rejects design exploration after being informed of trade-offs.
- All proposed approaches violate hard constraints and no alternative exists.
- Critical system context cannot be gathered (missing code, inaccessible modules).

On stop, report exactly what blocks progress or why design was skipped.

## Anti-Patterns (never)

- Writing any code or producing diffs before design approval.
- Skipping clarifying questions and assuming intent.
- Presenting a single approach as the only option.
- Producing generic designs not grounded in the actual codebase.
- Combining brainstorming with implementation in the same pass.
- Approving your own design without user confirmation.

## Red Flags

| Signal                                    | Risk                                    |
| ----------------------------------------- | --------------------------------------- |
| "Let me just code this up quickly"        | Skipping design; unexamined assumptions |
| Only one approach considered              | Missing trade-off analysis              |
| No questions asked                        | Intent not validated                    |
| Design references modules not inspected   | Groundless architecture                 |
| Scope boundary not defined                | Unbounded implementation                |
| `approval_status` never set to `approved` | Iron Law violation                      |

## Common Rationalizations (reject all)

| Rationalization                   | Why It Fails                                                |
| --------------------------------- | ----------------------------------------------------------- |
| "It's too simple for design"      | Simple tasks have the highest assumption-to-waste ratio     |
| "I already know how to do this"   | Knowledge ≠ validated design; context may have changed      |
| "The user wants speed"            | Rework from bad design is slower than a 5-minute brainstorm |
| "I'll design as I code"           | Produces local-optimum architecture and scope drift         |
| "There's only one way to do this" | Almost never true; constraints reveal alternatives          |

## Example

Input:

```text
"Add a cost-tracking dashboard to the runtime that shows per-turn token usage."
```

Expected flow:

1. **Step 0**: Scope guard — touches multiple modules (runtime.cost, events, possible new UI surface). Not a one-liner. Proceed.
2. **Step 1**: `DESIGN_CONTEXT` — inspect `runtime.cost.*`, event pipeline, existing telemetry surfaces.
3. **Step 2**: Clarify — "Should this be CLI-only or also available via gateway API?" / "Real-time streaming or poll-based?"
4. **Step 3**: `APPROACH_OPTIONS` — (A) extend existing event stream with cost annotations, (B) dedicated cost aggregation service, (C) lightweight in-memory accumulator with CLI dump.
5. **Step 4**: Present design sections — objective and components first, then data flow and error handling.
6. **Step 5**: `DESIGN_SPEC` with `approval_status: approved`.
7. **Step 6**: Hand off to `planning` with the approved spec.
