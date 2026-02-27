---
name: brewva-project
description: Project orchestration skill for Brewva source analysis, allocator-first runtime diagnosis, and issue/PR delivery.
version: 1.4.0
stability: stable
tier: project
tags: [project, migration, runtime, diagnostics, verification, delivery, context-arena]
anti_tags: []
tools:
  required: [read, grep]
  optional:
    - exec
    - process
    - look_at
    - lsp_goto_definition
    - lsp_find_references
    - lsp_symbols
    - lsp_diagnostics
    - lsp_prepare_rename
    - lsp_rename
    - ast_grep_search
    - ast_grep_replace
    - cost_view
    - ledger_query
    - schedule_intent
    - tape_handoff
    - tape_info
    - tape_search
    - session_compact
    - rollback_last_patch
    - skill_load
    - skill_complete
    - task_set_spec
    - task_add_item
    - task_update_item
    - task_record_blocker
    - task_resolve_blocker
    - task_view_state
    - memory_dismiss_insight
    - memory_review_evolves_edge
  denied: []
budget:
  max_tool_calls: 110
  max_tokens: 220000
outputs:
  [
    scope_alignment,
    workstream_decision,
    process_evidence,
    migration_plan,
    verification_matrix,
    delivery_report,
  ]
consumes: [architecture_map, execution_steps, findings, verification, runtime_artifacts]
escalation_path:
  constraint_missing: planning
  no_rollback_path: review
---

# Brewva Project Skill

## Objective

Enable evidence-led diagnosis and delivery for Brewva across two complementary analysis surfaces:

1. **Source surface** — understand the codebase: package boundaries, call paths, contracts, and minimal edit points.
2. **Process surface** — reconstruct runtime behavior from session artifacts (event store JSONL, evidence ledger, memory files, tape checkpoints, file snapshots, schedule projections) to confirm or refute hypotheses that source inspection alone cannot resolve.

Findings from both surfaces converge into a single delivery action: a well-evidenced issue, a reviewable PR, or an explicit "blocked" signal.
This skill is an orchestrator: it routes work across source analysis, process evidence analysis, and delivery actions without duplicating specialized pack/base skills.

## Trigger

Use this skill when requests involve:

- migration and feature integration into Brewva
- runtime behavior diagnosis from session logs and JSONL artifacts
- remediation of architecture-review P0/P1 gaps
- cross-package work (`runtime/tools/extensions/cli`)
- prioritized delivery requiring explicit verification and risk control

## Project Invariants (non-negotiable)

- Prefer migration of proven behavior over greenfield reinvention.
- Keep runtime contracts explicit and verifiable (tool policy, budgets, outputs).
- Any high-risk change must include rollback strategy and validation matrix.
- Prefer allocator-first context design over retrieval-first prompt patching.
- Avoid compatibility-only branches unless explicitly required by task scope.
- Source evidence and process evidence must converge before issue/PR escalation.

## Mode Detection (mandatory first output)

Classify the task into exactly one execution mode:

| Mode                       | Typical Work                                           | Goal                               |
| -------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `MIGRATION_IMPLEMENTATION` | capability migration, skill migration, behavior parity | land proven capabilities safely    |
| `RUNTIME_HARDENING`        | gate/security/contract strengthening                   | increase correctness and safety    |
| `RUNTIME_DIAGNOSIS`        | session log/JSONL analysis, behavioral anomaly triage  | locate defect via process evidence |
| `SKILL_SYSTEM_UPGRADE`     | skill content and resource system upgrades             | improve agent execution quality    |
| `RELEASE_READINESS`        | pre-release checks and risk convergence                | produce release-ready state        |

Blocking output (do not proceed without it):

```text
PROJECT_SCOPE_ALIGNMENT
- mode: <MIGRATION_IMPLEMENTATION|RUNTIME_HARDENING|RUNTIME_DIAGNOSIS|SKILL_SYSTEM_UPGRADE|RELEASE_READINESS>
- objective: "<single delivery objective>"
- in_scope:
  - "<item>"
- out_of_scope:
  - "<item>"
- success_signal:
  - "<observable signal>"
```

## Workstream Architecture (mandatory)

Treat execution as three coordinated lanes:

1. **Source Lane**: understand code boundaries, call paths, and minimal edit points.
2. **Process Lane**: reconstruct runtime behavior from session artifacts (event store, evidence ledger, memory files, tape checkpoints, file snapshots, schedule projections). See `skills/project/brewva-project/references/runtime-artifacts.md` for the full artifact catalog.
3. **Delivery Lane**: convert confirmed findings into issue/PR artifacts with reproducible evidence and explicit acceptance criteria.

This skill must orchestrate specialized skills instead of re-implementing their logic:

- **process evidence and session analysis**: `skills/project/brewva-session-logs/SKILL.md`
- source mapping and boundary discovery: `skills/base/exploration/SKILL.md`
- root-cause confirmation and hypothesis validation: `skills/base/debugging/SKILL.md`
- command-backed validation and verdicting: `skills/base/verification/SKILL.md`
- surgical code changes with rollback: `skills/base/patching/SKILL.md`
- execution plan construction: `skills/base/planning/SKILL.md`
- merge-safety review before delivery: `skills/base/review/SKILL.md`
- commit architecture and history operations: `skills/base/git/SKILL.md`
- issue/PR artifact generation and GitHub execution: `skills/packs/github/SKILL.md`
- issue triage to PR pipeline: `skills/packs/gh-issues/SKILL.md`

## Brewva Tools Alignment (mandatory)

This skill keeps `read` + `grep` as required baseline and explicitly aligns optional tools with
the current `@brewva/brewva-tools` runtime tool surface.

Operational routing:

- Source lane (`runtime/tools/extensions/cli` boundary tracing): `lsp_*`, `ast_grep_*`, `look_at`
- Process lane (runtime artifact reconstruction): `ledger_query`, `tape_info`, `tape_search`, `cost_view`, `process`
- Delivery lane (bounded execution and rollback): `task_*`, `skill_load`, `skill_complete`, `rollback_last_patch`
- Scheduling/continuity lane: `schedule_intent`
- Pressure/recovery lane: `session_compact`, `tape_handoff`

Limitation:

- This skill intentionally does **not** include generic mutation-only tools such as `write`/`edit`.
  Code mutation should flow through delegated skills (`patching`, `debugging`) so change boundaries,
  rollback strategy, and verification gates stay explicit.

## Execution Workflow

### Step 1: Priority Decision

Default priority order:

1. P0 (real command-backed verification, enforced contract outputs)
2. P1 (allocator-first context control plane, evidence quality semantics, memory/parallel completeness)
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

### Step 3: Workstream Decision (mandatory output)

Decide which investigation lanes are required before implementation:

- `source_lane` is required when code changes, API behavior, or contract boundaries are in scope.
- `process_lane` is required when runtime logs/JSONL/ledger evidence exists or when source inspection alone cannot explain observed behavior.
- if both are relevant, run both lanes and resolve discrepancies before delivery decisions.

Blocking output:

```text
WORKSTREAM_DECISION
- source_lane: <required|optional|skip + reason>
- process_lane: <required|optional|skip + reason>
- delegated_skills:
  - "<skill + responsibility>"
- delivery_target: <issue|pr|both|none>
- readiness_gate:
  - "<condition required before delivery action>"
```

### Step 4: Source Lane (when required)

Produce an executable source-level diagnosis:

- map entrypoints and hot path to the failing or target behavior
- identify the smallest safe change boundary
- rank 1-3 root-cause hypotheses and validation actions

Output template:

```text
SOURCE_ANALYSIS
- entrypoints:
  - "<path:function>"
- hot_path:
  - "<A -> B -> C>"
- change_boundary:
  - "<minimal files/interfaces to change>"
- hypotheses:
  - "<cause + validation action>"
- code_confidence: <high|medium|low>
```

### Step 5: Process Lane (when required)

Delegate process evidence collection to `skills/project/brewva-session-logs/SKILL.md`.

That skill provides:

- artifact location and field reference for all `.orchestrator` JSONL artifacts
- ready-made `jq`/`rg` recipes for event timeline, cost, ledger, memory, and tape queries
- context arena telemetry recipes (`context_injected`, `context_arena_*`, `context_external_recall_*`)
- hash chain integrity verification procedure
- replay engine guidance (`TurnReplayEngine`)

After collecting evidence via session-logs, summarize findings using:

```text
PROCESS_EVIDENCE
- evidence_inputs:
  - "<artifact path + record count>"
- chain_integrity: <verified|broken at row N|not applicable>
- timeline:
  - "<timestamped event>"
- anomalies:
  - "<unexpected transition, invariant break, or verdict pattern>"
- cost_signals:
  - "<budget exceeded | model cost spike | none>"
- evidence_confidence: <high|medium|low>
```

### Step 6: Convergence and Delivery Decision

Merge source and process findings into a single delivery target.

Rules:

- If root cause is confirmed and code changes are required, prepare patch + verification, then route to PR flow.
- If defect is confirmed but fix is not implemented yet, produce a high-signal issue draft with reproduction and acceptance criteria.
- If evidence is insufficient or contradictory, stop with explicit missing inputs and do not open speculative issue/PR.

Blocking output:

```text
MIGRATION_PLAN
- increments:
  - "<single-purpose increment + rollback>"
- selected_path: <implement-now|issue-first|blocked>
- delivery_channel:
  - "<github|gh-issues|local-draft>"
- handoff_criteria:
  - "<what must be true before opening issue/PR>"
```

### Step 7: Slice into Reviewable Increments

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

### Step 8: Execution Guardrails

- Read target files and adjacent dependencies before any modification.
- Keep changes strictly within required scope.
- If constraints shift or risk escalates, return to planning immediately.
- Do not open issue/PR artifacts without direct evidence linkage.

### Step 9: Verification Matrix (mandatory output)

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

### Step 10: Delivery Report (mandatory output)

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
- Prefer composing specialized skills over duplicating their procedures in this skill.

## Stop Conditions

- Critical constraint is missing and changes solution correctness.
- High-risk change has no rollback path.
- Required verification checks are not executable and no substitute evidence exists.
- Required verification is blocked and no meaningful `TOOL_BRIDGE` can be produced.
- Process evidence lacks usable correlation keys and cannot be normalized reliably.

When stopping, always report:

1. completed vs pending boundaries
2. highest current risk
3. minimal input needed to proceed

When executable verification is blocked by environment constraints, emit `TOOL_BRIDGE` using
`skills/base/planning/references/executable-evidence-bridge.md`.

## Anti-Patterns (forbidden)

- Mixing P0 remediation with low-value opportunistic optimization.
- Expanding edits across packages without impact mapping.
- Replacing executable evidence with purely theoretical reasoning.
- Migrating only skeleton structure without operational knowledge.
- Opening issue/PR actions without source-process evidence convergence.
- Inlining JSONL parsing recipes instead of delegating to `brewva-session-logs`.
- Analyzing evidence ledger without first verifying hash chain integrity (session-logs enforces this).
- Manual JSONL parsing when `TurnReplayEngine` can reconstruct the target state directly.

## Resource Navigation

### Project References

- Runtime artifact catalog: `skills/project/brewva-project/references/runtime-artifacts.md`
- Priority matrix and phased strategy: `skills/project/brewva-project/references/migration-priority-matrix.md`
- Package boundaries and invariants: `skills/project/brewva-project/references/package-boundaries.md`
- Skill DoD quick-check script: `skills/project/brewva-project/scripts/check-skill-dod.sh`

### Delegated Skills — Feedback Loop

- Self-improvement and learning capture: `skills/project/brewva-self-improve/SKILL.md`

### Delegated Skills — Process Lane

- Session log queries and runtime artifact analysis: `skills/project/brewva-session-logs/SKILL.md`

### Delegated Skills — Source Lane

- Source discovery method: `skills/base/exploration/SKILL.md`
- Root-cause workflow: `skills/base/debugging/SKILL.md`
- Verification workflow: `skills/base/verification/SKILL.md`

### Delegated Skills — Delivery Lane

- Surgical patching: `skills/base/patching/SKILL.md`
- Execution planning: `skills/base/planning/SKILL.md`
- Merge-safety review: `skills/base/review/SKILL.md`
- Git operations: `skills/base/git/SKILL.md`
- GitHub issue/PR operations: `skills/packs/github/SKILL.md`
- Issue-triage to PR pipeline: `skills/packs/gh-issues/SKILL.md`

## Examples

### Example A — Process-led diagnosis

Input:

```text
"Analyze runtime JSONL and verification logs for tool-budget failures, localize the code path, and decide whether to open an issue or a PR."
```

Expected flow:

1. Output `PROJECT_SCOPE_ALIGNMENT` (mode: `RUNTIME_DIAGNOSIS`).
2. Output `IMPACT_MAP` (at minimum covering runtime + extensions).
3. Output `WORKSTREAM_DECISION` — activate both Source and Process lanes.
4. **Process Lane**: verify ledger hash chain, filter `cost_update` events for budget spikes, inspect `context_arena_*` and `context_external_recall_*` transitions for control-path anomalies, correlate `verdict: "fail"` rows with `sessionId:turn`, optionally replay to the failing turn via `TurnReplayEngine`.
5. **Source Lane**: trace the code path from the identified tool call to the budget enforcement gate.
6. Converge into `MIGRATION_PLAN` with `selected_path: implement-now | issue-first | blocked`.
7. Execute minimal, reviewable increments and output `VERIFICATION_MATRIX` and `DELIVERY_REPORT`.

### Example B — Source-led migration

Input:

```text
"Harden the context arena control plane (adaptive zones + floor_unmet recovery + SLO enforcement) and close any event/doc mismatch."
```

Expected flow:

1. Output `PROJECT_SCOPE_ALIGNMENT` (mode: `MIGRATION_IMPLEMENTATION`).
2. Output `IMPACT_MAP` (runtime + extensions + cli).
3. Output `WORKSTREAM_DECISION` — Source Lane required, Process Lane required (control-plane changes need runtime evidence confirmation).
4. **Source Lane**: map arena/controller/orchestrator entrypoints, identify contract differences, determine minimal change boundary.
5. Converge into `MIGRATION_PLAN` with increments sequenced as type prerequisites → runtime logic → integration → tests.
6. Output `VERIFICATION_MATRIX` and `DELIVERY_REPORT`.
