# System Architecture

## Philosophy

Brewva is a Governance Kernel Runtime.

The system optimizes for one question:

`Why can we trust this agent behavior?`

Design priority:

1. evidence and replayability
2. bounded execution and cost
3. deterministic context control
4. operator-friendly contracts

## Core Kernel

### Trust Layer

- `EvidenceLedger`: append-only evidence chain
- `VerificationService`: verification outcome + blocker integration
- `TruthService`: explicit runtime facts

### Boundary Layer

- `ToolGateService`: execution authorization + policy checks
- `SessionCostTracker` + `CostService`: cost boundary and budget actions
- `ContextBudgetManager` + compaction gate: context boundary

### Contract Layer

- `SkillLifecycleService`: skill activation/completion contracts
- `SkillCascadeService`: contract-driven chain progression
- `TaskService`: task spec/item/blocker state machine

### Durability Layer

- event tape (`BrewvaEventStore`)
- checkpoint + delta replay (`TurnReplayEngine`)
- turn WAL (`TurnWALStore`, `TurnWALRecovery`)

## Projection Model

Projection state is working-only:

- source-of-truth: event tape
- projection: `.orchestrator/projection/units.jsonl`
- working snapshot: `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/working.md`
- injected source: `brewva.projection-working` only

No recall lane and no external recall runtime branch are part of the kernel.

## Context Model

Context injection is single-path and deterministic:

- governance source registration
- arena planning
- global budget clamp
- hard-limit compaction gate

Arena SLO is an execution boundary, not an inference selector.

## Governance Port

`BrewvaRuntimeOptions.governancePort` is optional and governance-only:

- `verifySpec`
- `detectCostAnomaly`
- `checkCompactionIntegrity`

These checks enrich auditability; they do not introduce adaptive inference paths.

## Control Plane Boundary

Optional control-plane components may provide operator-facing assistance outside
the kernel path. For example, the external skill broker can use lexical or
model-assisted judging to produce explicit preselection.

When that broker path is enabled:

- selection happens before runtime routing
- runtime runs with `skills.selector.mode=external_only`
- the kernel remains governance-only for dispatch, gate, evidence, and replay

This preserves the runtime/kernel promise: the kernel governs execution; it does
not run adaptive model routing inside the core path.

## Extensions

Extensions can shape operator UX (for example capability disclosure), but kernel
governance decisions remain in runtime services.

## Non-goals

- runtime-managed model routing inference
- multi-tier adaptive projection structures
- multi-branch context retrieval heuristics
