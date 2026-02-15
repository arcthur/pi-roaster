---
name: planning
description: Build execution-ready implementation plans with assumptions, risks, and validations.
version: 1.0.0
stability: stable
tier: base
tags: [plan, roadmap, architecture, scope]
anti_tags: [quick-fix]
tools:
  required: [read]
  optional: [grep, ledger_query, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 60
  max_tokens: 130000
outputs: [objective, assumptions, options, execution_steps, risk_register, verification_plan]
consumes: [architecture_map, key_modules, unknowns, root_cause]
escalation_path:
  system_unclear: exploration
  all_options_violate_constraints: review
---

# Planning Skill

## Intent
Create decision-complete plans that are executable, verifiable, and bounded by clear risks.

## Trigger
Use this skill when the task is:
- Ambiguous and requires strategy choices.
- Multi-step across modules.
- High risk (API, persistence, migration, or concurrency impact).

Skip this skill for trivial one-file fixes with obvious implementation.

## Planning Workflow

### Step 1: Classify intent (mandatory)
Classify task before proposing options.

| Intent Class | Typical Scope | Default Strategy |
| --- | --- | --- |
| `SIMPLE_FIX` | <=3 files, no API/data contract change | implement directly with short verification |
| `FEATURE` | additive behavior, moderate scope | option comparison + phased rollout |
| `REFACTOR` | internal structure change | safety-first plan + regression checks |
| `ARCHITECTURE` | cross-module boundary change | deeper exploration + risk register |
| `INVESTIGATION` | unknown root cause or behavior | exploration plan before implementation |

Blocking output:
```text
INTENT_CLASSIFICATION
- class: <SIMPLE_FIX|FEATURE|REFACTOR|ARCHITECTURE|INVESTIGATION>
- confidence: <high|medium|low>
- reason: "<one-sentence rationale>"
```

### Step 2: Gather constraints and invariants
Collect hard constraints before plan design:
- language/runtime/tooling constraints
- compatibility and migration constraints
- performance or latency expectations
- safety requirements (data, auth, policy)

Capture assumptions explicitly if data is missing.

### Step 3: Interview mode for ambiguity (max 3 questions)
Ask clarifying questions only when answers materially change architecture or correctness.

Question policy:
- ask at most 3 questions
- prioritize irreversible decisions first
- if uncertainty is low-risk, proceed with explicit assumptions

Template:
```text
CLARIFY_Q1: "<question>"
WHY_IT_MATTERS: "<decision impacted>"
DEFAULT_IF_NO_ANSWER: "<assumption>"
```

### Step 4: Exploration-first strategy
Before choosing options, inspect current system shape.

Recommended exploration sequence:
```bash
rg --files
rg "<core symbol or endpoint>"
```

Exploration scope rules:
- Start broad: entry points, routing, package boundaries.
- Then go deep: 2-4 critical files on the hot path.
- Avoid reading entire repository unless task is architecture-level.

Output:
```text
SYSTEM_SNAPSHOT
- key_modules:
  - <module>
  - <module>
- boundaries: "<how modules interact>"
- unknowns:
  - <open question>
```

### Step 5: Generate options (1-3 only)
Each option must include:
- approach summary
- impact scope (files/modules/interfaces)
- pros
- cons
- risks
- validation plan

Option template:
```text
OPTION_A
- summary: "<approach>"
- impact_scope:
  - <module or file pattern>
- pros:
  - <point>
- cons:
  - <point>
- risks:
  - <risk>
- validation:
  - <check>
```

Avoid creating multiple options that are effectively the same.

### Step 6: Choose one option with explicit rationale
Selection rules:
1. correctness and safety
2. explicit business constraints
3. maintainability and future evolution
4. performance/resource cost
5. local code brevity

Blocking output:
```text
PLAN_DECISION
- selected_option: <A|B|C>
- rationale: "<why this is best under constraints>"
- rejected_options:
  - "<option + rejection reason>"
```

### Step 7: Build execution plan with checkpoints
Plan must be atomic and reviewable.

Execution plan requirements:
- each step has clear outcome
- each step can be validated independently
- sequencing reflects dependencies
- rollback point for risky operations

Template:
```text
EXECUTION_STEPS
1. "<step>" -> output: "<artifact>" -> verify: "<check>"
2. "<step>" -> output: "<artifact>" -> verify: "<check>"
3. "<step>" -> output: "<artifact>" -> verify: "<check>"
```

### Step 8: Build risk register and verification plan
Risk template:
```text
RISK_REGISTER
- risk: "<what can fail>"
- likelihood: <low|medium|high>
- impact: <low|medium|high>
- mitigation: "<prevention>"
- fallback: "<rollback or containment>"
```

Verification template:
```text
VERIFICATION_PLAN
- unit_scope: "<targeted checks>"
- integration_scope: "<cross-module checks>"
- non_functional_scope: "<performance/security/reliability if applicable>"
- acceptance_criteria:
  - "<criterion>"
  - "<criterion>"
```

## Stop Conditions
- System shape remains unclear after focused exploration.
- Critical constraint is unknown and changes architecture decision.
- All options violate a hard constraint.

On stop, report exactly what missing input blocks progress.

## Anti-Patterns (never)
- Producing an implementation diff before reading relevant code.
- Asking many low-value questions instead of making assumptions.
- Presenting generic plans not tied to real modules.
- Ignoring verification details until after coding.
- Treating risky migration as a single-step task.

## References
- Standard plan packet template: `skills/base/planning/references/plan-output-template.md`

## Example

Input:
```text
"We need to migrate verification gate from evidence-only to command-backed checks."
```

Expected outputs:
1. `INTENT_CLASSIFICATION`: `ARCHITECTURE`.
2. `SYSTEM_SNAPSHOT`: current gate path and command config coupling.
3. `OPTION_A/B`: wrapper-only vs evaluate() redesign.
4. `PLAN_DECISION` with risk-driven rationale.
5. `EXECUTION_STEPS` + `RISK_REGISTER` + `VERIFICATION_PLAN`.
