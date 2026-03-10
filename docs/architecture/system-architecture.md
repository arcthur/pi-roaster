# System Architecture

## Philosophy

Brewva is a Commitment Runtime.

The system optimizes for one question:

`Why can we trust this agent behavior?`

Constitution:

`Intelligence proposes. Kernel commits. Tape remembers.`

Design priority:

1. evidence and replayability
2. bounded execution and cost
3. deterministic context control
4. operator-friendly contracts

Further reading:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/proposal-boundary.md`

## Three Rings

- `Kernel Ring`: commitment, gates, verification, replay, recovery, fail-closed behavior
- `Deliberation Ring`: ranking, planning, proposal generation, multi-model orchestration
- `Experience Ring`: CLI, gateway, channels, debug-loop controller, operator UX

Boundary rule:

- outer intelligence may propose
- kernel may accept, reject, or defer
- every committed decision produces a receipt
- tape is commitment memory, not a best-effort log

## Operational Planes

- `Working State Plane`: projection, context arena, pending dispatch, active tool surface
- `Cognitive Product Plane`: context composition, memory curation, persona/profile rendering
- `Control Plane`: broker, debug-loop, heartbeat policy, scheduling triggers, future planners

Rings define authority. Planes define product behavior.

## State Taxonomy

Brewva keeps five different kinds of system objects separate:

| Category                 | Role                                                            | Authority                    | Typical carriers                                     |
| ------------------------ | --------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `Kernel Commitments`     | authoritative system commitments                                | authoritative                | tape, receipts, task, truth, ledger                  |
| `Working State`          | session-local working view and injection planning               | non-authoritative            | projection, context arena, pending dispatch          |
| `Deliberation Artifacts` | non-kernel cognition and cross-session sediment                 | non-authoritative            | `.brewva/cognition/*`, broker traces, operator notes |
| `Tool Surface`           | turn-visible action surface                                     | policy-governed              | base tools, skill-scoped tools, operator tools       |
| `Control Plane`          | scheduling, ranking, retry loops, operator-facing orchestration | non-authoritative by default | broker, debug-loop, gateway heartbeat/policy         |

Important distinctions:

- projection is working state, not a long-term memory tier
- context arena is an injection planner, not a memory system
- deliberation artifacts may survive across sessions, but they only enter kernel
  context through accepted `context_packet` proposals
- tool surface should reflect the current commitment boundary, not the full
  static capability catalog

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

Projection is one context source, not a parallel memory system. Cross-session
knowledge sediment belongs in deliberation artifacts, then re-enters through
proposal-backed `context_packet` injection.

## Context Model

Context injection is single-path and deterministic:

- governance source registration
- arena planning
- global budget clamp
- hard-limit compaction gate

Arena SLO is an execution boundary, not an inference selector.

Projection and arena are not parallel memories:

- projection provides one deterministic source snapshot
- arena plans which sources fit the current injection budget

Model-facing composition is a separate concern:

- runtime admission decides which sources are allowed and budget-safe
- `ContextComposer` decides how admitted blocks are shown to the model
- default full-extension behavior is narrative-first
- concise diagnostics appear only on anomaly or explicit diagnostic request

## Tool Surface

Tool visibility is part of governance, not just packaging.

The runtime/extension stack now treats tool surface as three layers:

- `base tools`: always-on core tools and low-level session controls
- `active-skill tools`: tools required or optionally allowed by the current
  active/pending/cascade skill contracts
- `operator tools`: observability and operator-facing controls exposed only for
  operator profiles or explicit capability requests

This keeps the visible action surface aligned with the current commitment
context instead of exposing the entire static tool bundle on every turn.

## Governance Port

`BrewvaRuntimeOptions.governancePort` is optional and governance-only:

- `verifySpec`
- `detectCostAnomaly`
- `checkCompactionIntegrity`

These checks enrich auditability; they do not introduce adaptive inference paths.

## Control Plane Boundary

Optional control-plane components may provide operator-facing assistance outside
the kernel path. For example, a skill broker or planner may produce
`skill_selection` or `skill_chain_intent` proposals. Shared proposal/evidence
helpers live in `@brewva/brewva-deliberation`.

Cross-session cognition sediment follows the same rule:

- control-plane or extension code writes non-authoritative artifacts under
  `.brewva/cognition/*`
- `MemoryCurator` may rehydrate selected artifacts into `context_packet` proposals
- kernel commitment still happens only at the proposal boundary

When that path is enabled:

- selection and planning happen before kernel commitment
- proposals cross the boundary through `runtime.proposals.submit(...)`
- the kernel remains governance-only for dispatch gates, cascade activation,
  evidence, and replay

This preserves the kernel promise: the kernel governs execution, but adaptive
selection logic stays outside the core path.

## Extensions

Extensions can shape operator UX (for example capability disclosure), but kernel
governance decisions remain in runtime services.

## Non-goals

- runtime-managed model routing inference
- multi-tier adaptive projection structures
- multi-branch context retrieval heuristics
