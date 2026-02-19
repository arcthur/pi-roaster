---
name: brewva-project
description: Project control skill for Brewva migration, runtime hardening, and delivery readiness.
version: 1.0.0
stability: stable
tier: project
tags: [project, migration, runtime, verification, delivery]
anti_tags: []
tools:
  required: [read, grep]
  optional: [exec, ledger_query, lsp_diagnostics, skill_load, skill_complete]
  denied: []
budget:
  max_tool_calls: 110
  max_tokens: 220000
outputs:
  [scope_alignment, workstream_decision, migration_plan, verification_matrix, delivery_report]
consumes: [architecture_map, execution_steps, findings, verification]
escalation_path:
  constraint_missing: planning
  no_rollback_path: review
---

# Brewva Project Skill

## Objective

Turn migration and hardening work in Brewva into an executable, verifiable, and reversible delivery flow while preserving upstream compatibility.

## Trigger

Use this skill when requests involve:

- migration and feature integration into Brewva
- remediation of architecture-review P0/P1 gaps
- cross-package work (`runtime/tools/extensions/cli`)
- prioritized delivery requiring explicit verification and risk control

## Project Invariants (non-negotiable)

- Prefer migration of proven behavior over greenfield reinvention.
- Keep runtime contracts explicit and verifiable (tool policy, budgets, outputs).
- Any high-risk change must include rollback strategy and validation matrix.
- Preserve compatibility path with upstream `pi-coding-agent`.

## Mode Detection (mandatory first output)

Classify the task into exactly one execution mode:

| Mode                       | Typical Work                                           | Goal                            |
| -------------------------- | ------------------------------------------------------ | ------------------------------- |
| `MIGRATION_IMPLEMENTATION` | capability migration, skill migration, behavior parity | land proven capabilities safely |
| `RUNTIME_HARDENING`        | gate/security/contract strengthening                   | increase correctness and safety |
| `SKILL_SYSTEM_UPGRADE`     | skill content and resource system upgrades             | improve agent execution quality |
| `RELEASE_READINESS`        | pre-release checks and risk convergence                | produce release-ready state     |

Blocking output (do not proceed without it):

```text
PROJECT_SCOPE_ALIGNMENT
- mode: <MIGRATION_IMPLEMENTATION|RUNTIME_HARDENING|SKILL_SYSTEM_UPGRADE|RELEASE_READINESS>
- objective: "<single delivery objective>"
- in_scope:
  - "<item>"
- out_of_scope:
  - "<item>"
- success_signal:
  - "<observable signal>"
```

## Execution Workflow

### Step 1: Priority Decision

Default priority order:

1. P0 (real command-backed verification, enforced contract outputs)
2. P1 (context injection model, evidence quality semantics, memory/parallel completeness)
3. P2 (checkpointing, skill test harness, security sanitization hardening)

If user direction conflicts with this order, proceed only after explicitly stating risk trade-offs.

### Step 2: Impact Modeling

Map impact before editing:

- package boundaries (`runtime/tools/extensions/cli`)
- contract boundaries (frontmatter, tool policy, budget, outputs)
- evidence and verification chain (ledger, verification gate)

Output template:

```text
IMPACT_MAP
- packages:
  - "<package + impact>"
- contracts:
  - "<contract field + impact>"
- verification:
  - "<check path>"
```

### Step 3: Slice into Reviewable Increments

Each increment must be:

- single-purpose and independently verifiable
- reversible with clear rollback
- free from unrelated refactor noise

Preferred sequencing:

1. type/interface prerequisites
2. runtime logic changes
3. tool/extension integration
4. tests and verification closure
5. docs/skill sync

### Step 4: Execution Guardrails

- Read target files and adjacent dependencies before any modification.
- Keep changes strictly within required scope.
- If constraints shift or risk escalates, return to planning immediately.

### Step 5: Verification Matrix (mandatory output)

Verification must match impact surface. Do not use informal claims.

```text
VERIFICATION_MATRIX
- contract_checks:
  - "<check + result>"
- runtime_checks:
  - "<check + result>"
- integration_checks:
  - "<check + result>"
- residual_risks:
  - "<risk>"
```

### Step 6: Delivery Report (mandatory output)

```text
DELIVERY_REPORT
- completed_scope:
  - "<done item>"
- deferred_scope:
  - "<deferred item + reason>"
- evidence:
  - "<command/test/log>"
- next_recommended_step: "<single best next step>"
```

## Decision Rules

- Correctness and safety take precedence over brevity and optimization.
- Satisfy hard constraints first, optimize second.
- Prefer options with stronger verification and rollback characteristics.

## Stop Conditions

- Critical constraint is missing and changes solution correctness.
- High-risk change has no rollback path.
- Required verification checks are not executable and no substitute evidence exists.

When stopping, always report:

1. completed vs pending boundaries
2. highest current risk
3. minimal input needed to proceed

## Anti-Patterns (forbidden)

- Mixing P0 remediation with low-value opportunistic optimization.
- Expanding edits across packages without impact mapping.
- Replacing executable evidence with purely theoretical reasoning.
- Migrating only skeleton structure without operational knowledge.

## Resource Navigation

- Priority matrix and phased strategy: `skills/project/brewva-project/references/migration-priority-matrix.md`
- Package boundaries and invariants: `skills/project/brewva-project/references/package-boundaries.md`
- Skill DoD quick-check script: `skills/project/brewva-project/scripts/check-skill-dod.sh`

## Example

Input:

```text
"Continue the next migration phase and resolve the P0 verification gate gap first."
```

Expected flow:

1. Output `PROJECT_SCOPE_ALIGNMENT` (mode should be `RUNTIME_HARDENING`).
2. Output `IMPACT_MAP` (at minimum covering runtime + extensions).
3. Execute minimal, reviewable increments.
4. Output `VERIFICATION_MATRIX` and `DELIVERY_REPORT`.
