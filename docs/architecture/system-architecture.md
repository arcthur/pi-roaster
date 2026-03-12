# System Architecture

## Philosophy

Brewva is a Commitment Runtime.

The system optimizes for one question:

`Why can we trust this agent behavior?`

Constitution:

`Intelligence proposes. Kernel commits. Tape remembers.`

Implementation-grade constitutional reading:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

This does not replace the constitution. It clarifies the same boundary at the
granularity now used by the runtime:

- `proposes / explores` belongs to deliberation and control-plane layers
- `commits / authorizes effects` belongs to kernel authority
- `Tape remembers commitments` means the tape records committed outcomes rather
  than every intermediate reasoning path

Design priority:

1. evidence and replayability
2. bounded execution and cost
3. deterministic context control
4. operator-friendly contracts

Further reading:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/reference/proposal-boundary.md`

## Three Rings

- `Kernel Ring`: commitment, gates, verification, replay, recovery, fail-closed behavior
- `Deliberation Ring`: ranking, planning, proposal generation, multi-model orchestration
- `Experience Ring`: CLI, gateway, channels, debug-loop controller, operator UX

Boundary rule:

- outer intelligence may propose
- kernel may accept, reject, or defer
- explicit governance-owned direct-commit flows may exist, but they must stay
  narrow and receipt-bearing
- every committed decision produces a receipt
- tape is commitment memory, not a best-effort log

## Operational Planes

- `Working State Plane`: projection, context arena, pending dispatch, active tool surface
- `Cognitive Product Plane`: context composition, memory formation, memory curation, persona/profile rendering
- `Control Plane`: broker, debug-loop, heartbeat policy, proactive wake context, scheduling triggers, future planners

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
  - Current authority is effect authorization plus effective resource ceilings
  - A small set of runtime-owned control-plane tools remains explicitly exempted
    for recovery and negotiation; those exceptions are narrow and auditable
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
- `skill-informed tools`: preferred/fallback hints plus effect-authorized
  managed skill tools derived from the current active/pending/cascade contracts
- `operator tools`: observability and operator-facing controls exposed only for
  operator profiles by default, or per-turn explicit `$tool_name` disclosure
  requests

This keeps the visible action surface aligned with the current commitment
context instead of exposing the entire static tool bundle on every turn.

Current rule:

- the visible tool surface helps the model understand available paths
- governance authority sits on effect classes and resource ceilings, not on
  tool-path
  prescription
- tool surface may influence deliberation, but it does not define kernel
  authority by itself

## Governance Port

`BrewvaRuntimeOptions.governancePort` is optional and governance-only:

- `verifySpec`
- `detectCostAnomaly`
- `checkCompactionIntegrity`

These checks enrich auditability; they do not introduce adaptive inference paths.

## Control Plane Boundary

Optional control-plane components may provide operator-facing assistance outside
the kernel path. For example, a skill broker or planner may produce
`skill_selection` proposals or direct cascade intents. Shared proposal/evidence
helpers for the remaining boundary live in `@brewva/brewva-deliberation`.

Cross-session cognition sediment follows the same rule:

- control-plane or extension code writes non-authoritative artifacts under
  `.brewva/cognition/*`
- `MemoryCurator` may rehydrate selected artifacts into `context_packet` proposals
- cognitive artifacts still cross through the proposal boundary
- budget expansion uses a separate receipt-bearing governance path via
  `resource_lease`

When that path is enabled:

- selection and planning happen before kernel commitment
- proposals cross the boundary through `runtime.proposals.submit(...)`
- `resource_lease` may record direct budget commitments without granting new
  effect authorization
- managed Brewva tool definitions now expose first-class `brewva.governance`
  metadata as a canonical view over the exact managed-tool policy, and the
  default gateway path imports it only for tools the runtime does not already
  classify exactly
- the kernel remains governance-only for dispatch commitments, cascade activation,
  evidence, and replay

This preserves the kernel promise: the kernel governs execution, but adaptive
selection logic stays outside the core path.

Current evolution rule:

- make deliberation thicker so it owns path search, retries, reordering, and
  lease negotiation
- make contracts lighter so they express more `intent` and `effect`
- make governance look more like effect authorization than a prewritten
  execution script

## Extensions

Extensions can shape operator UX (for example tool-surface disclosure), but kernel
governance decisions remain in runtime services.

## Non-goals

- runtime-managed model routing inference
- multi-tier adaptive projection structures
- multi-branch context retrieval heuristics
