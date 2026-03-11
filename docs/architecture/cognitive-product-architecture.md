# Cognitive Product Architecture

This document defines Brewva's product-facing cognitive architecture without
changing the underlying constitutional line:

`Intelligence proposes. Kernel commits. Tape remembers.`

## Taxonomy

Brewva uses two architectural taxonomies and keeps them separate:

- `Rings` define authority boundaries.
- `Planes` define cross-cutting operational concerns.

### Rings

- `Kernel Ring`
  - authoritative commitments
  - proposal admission
  - verification, replay, WAL, receipts, fail-closed gates
- `Deliberation Ring`
  - proposal generation
  - ranking, selection, planning, rehydration strategies
- `Experience Ring`
  - CLI, gateway, channels, operator UX, lifecycle adapters

### Planes

- `Working State Plane`
  - projection
  - context arena
  - pending dispatch
  - current visible tool surface
- `Cognitive Product Plane`
  - context composition for the model
  - cross-session memory curation
  - cross-session memory formation
  - persona/profile rendering
- `Control Plane`
  - broker, debug-loop, heartbeat, wake planning, future planners, scheduling triggers
  - adaptation telemetry and formation/ranking feedback

Planes may span rings. For example, context composition reads kernel-approved
working state, deliberation artifacts, and current tool surface, then emits a
model-facing view through experience hooks.

## Core Principle

The long-term product rule is:

`Model sees narrative. Operator sees telemetry. Kernel sees receipts.`

Consequences:

- kernel state remains authoritative and replayable
- operator telemetry does not become default model context
- model-facing context is composed from admitted sources, not from raw runtime
  dashboards

## Cognitive Product Plane

The cognitive plane owns model-facing behavior that should not become kernel
authority:

- `ContextComposer`
  - arranges admitted context into model-facing narrative, constraint, and
    diagnostic blocks
- `MemoryCurator`
  - selects cross-session cognition artifacts and rehydrates them through
    evidence-backed `context_packet` proposals
- `PersonaProfile`
  - deterministic rendering of stable identity/workstyle signals from
    workspace-owned identity artifacts
  - current identity headings: `Who I Am`, `How I Work`, `What I Care About`
  - files without those headings are ignored by the persona renderer
- `MemoryFormation`
  - writes non-authoritative status summaries to `.brewva/cognition/summaries/`
  - writes non-authoritative episode artifacts to `.brewva/cognition/summaries/`
  - writes verified procedural notes to `.brewva/cognition/reference/`
  - captures resumable state at session boundaries instead of promoting it into
    kernel truth/task state
  - stamps resumable summaries and episodes with `session_scope` so process
    memory stays bound to the target live session while reference/procedure
    notes remain workspace-scoped

This plane may read kernel state, but it does not mutate kernel state directly.
All commitment changes still cross the proposal boundary.

Current module anchors:

- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`
- `packages/brewva-runtime/src/context/identity.ts`

## ContextComposer Boundary

`ContextComposer` is not a replacement for kernel context admission.

Responsibilities:

- consume already-admitted context entries from `runtime.context.buildInjection(...)`
- classify them as `narrative`, `constraint`, or `diagnostic`
- order the visible blocks for the current turn
- emit composition metrics such as narrative-token ratio

Non-responsibilities:

- source registration
- source admission
- budget planning
- deduplication or fingerprinting
- compaction lifecycle management

That means the split stays:

- kernel runtime:
  - source registration
  - budget clamp
  - deterministic admission
- extension lifecycle adapter:
  - `turn_start`, `context`, `session_compact`, `session_shutdown`
  - compaction state machine
- cognitive plane:
  - final model-facing composition

## MemoryCurator Boundary

`MemoryCurator` is the single entry point for cross-session cognition
rehydration.

It replaces ad-hoc artifact rehydration hooks by enforcing one path:

1. select relevant non-authoritative artifacts from `.brewva/cognition/*`
2. wrap them as evidence-backed `context_packet` proposals
3. let the kernel accept, reject, or defer

Current strategy set:

- `reference match`
  - BM25-style local ranking over `.brewva/cognition/reference/`
- `procedure match`
  - semantic subset of the `reference/` lane
  - rehydrates verified `ProcedureNote` artifacts as reusable work patterns
- `episode resume`
  - semantic subset of the `summaries/` lane
  - rehydrates bounded process history from `EpisodeNote` artifacts
- summary resume
- open-loop resume
  - trigger-aware query expansion may add heartbeat objective/hints before local
    ranking runs

Storage and retrieval are intentionally not one-to-one:

- storage lanes:
  - `reference`
  - `summaries`
- retrieval strategies:
  - `reference`
  - `procedure`
  - `episode`
  - `summary`
  - `open_loop`

Current mapping:

- `reference` lane -> `reference` or `procedure`
  - `procedure` is a semantic subset identified from `ProcedureNote` content
- `summaries` lane -> `summary`, `episode`, or `open_loop`
  - `episode` is a semantic subset identified from `EpisodeNote` content
  - `open_loop` is a semantic filter over unresolved `StatusSummary` content

Scope model is intentionally split:

- workspace-scoped cognition knowledge
  - `reference`
  - `procedure`
- session-scoped process memory
  - `summary`
  - `episode`
  - `open_loop`

Stable knowledge may travel across sessions in the same workspace. Resumable
process state stays bound to the target live session through `session_scope`.

This is an intentional design rule:

`storage authority != retrieval semantics`

The kernel only needs two storage roots. The curator may expose richer
rehydration strategies without creating new kernel-owned lanes.

All strategies must converge through the same curator so they do not compete
silently for context budget.

## Memory Formation Boundary

`MemoryFormation` is the write-side counterpart to `MemoryCurator`.

Responsibilities:

- observe session-boundary and phase-boundary signals such as `agent_end`,
  `session_compact`, and `session_shutdown`
- write replay-independent cognition summaries into
  `.brewva/cognition/summaries/`
- write replay-independent episode artifacts into
  `.brewva/cognition/summaries/`
- write replay-independent verified procedural notes into
  `.brewva/cognition/reference/`
- record non-authoritative resumable fields such as `phase`, `next_action`,
  `blocked_on`, and recent completed skill outputs
- distill reusable verification guidance from replayable
  `verification_outcome_recorded` evidence
- apply control-plane quality guidance before persisting low-signal summaries,
  episodes, or procedures
- avoid duplicate sediment by skipping repeated snapshots with the same
  semantic fingerprint within the same live session

Non-responsibilities:

- mutating kernel state
- bypassing proposal receipts
- writing project truth or task commitments
- deciding which artifact must be shown to the model in a later session

The write-side rule is:

`Formation persists. Curator selects. Kernel still commits.`

## Proactivity

Proactivity belongs to the `Control Plane`, not the kernel.

Heartbeat, scheduler rules, broker triggers, and debug-loop retries may wake
intelligence up, but they still produce proposals or durable artifacts instead
of implicit kernel mutations.

Current module anchors:

- gateway heartbeat policy and session wake-up:
  - `packages/brewva-gateway/src/daemon/heartbeat-policy.ts`
  - `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
  - `packages/brewva-gateway/src/daemon/session-supervisor.ts`
- proactivity trigger bridge:
  - `packages/brewva-gateway/src/runtime-plugins/proactivity-context.ts`
- wake policy and wake planning:
  - `packages/brewva-gateway/src/runtime-plugins/proactivity-engine.ts`
- control-plane observability of cognitive outcomes:
  - `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts`

`ProactivityEngine` owns four decisions:

- `wake policy`
  - whether a trigger should wake intelligence at all
- `wake plan`
  - which session to wake, with which objective, and with which retrieval hints
- `skip policy`
  - when a trigger should be suppressed because no unresolved or relevant work
    is likely to benefit from wake-up
- `wake context assembly`
  - bounded trigger text assembled from prompt, objective, hints, and recent
    open-loop or episode signals before `MemoryCurator` runs

`ProactivityEngine` remains control-plane only:

- it may inspect cognition artifacts and trigger metadata
- it may emit replayable wake and skip telemetry
- it may not mutate kernel state or bypass proposal admission

## Memory Quality Governance

Memory quality governance also belongs to the `Control Plane`.

Current module anchors:

- `packages/brewva-gateway/src/runtime-plugins/memory-adaptation.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`

This loop now has two effects:

- retrieval-side
  - strategy-level and packet-level usefulness bias changes curator ranking
- formation-side
  - adaptation guidance can suppress low-signal writes or require stronger
    formation evidence before persisting an artifact

This keeps quality control outside the kernel while letting the cognitive layer
become more selective over time.

## Operator Teaching

Operator teaching is a high-signal external input path, not a kernel mutation
mechanism.

Current module anchors:

- `packages/brewva-tools/src/cognition-note.ts`
- `packages/brewva-deliberation/src/cognition.ts`

Rules:

- operators may append or supersede `reference`, `procedure`, and `episode`
  artifacts under `.brewva/cognition/*`
- operator teaching writes external cognition artifacts only
- duplicate `record` operations are rejected by semantic name within the same
  operator-teaching kind
- `supersede` remains append-only on disk, but retrieval and operator listing
  collapse older versions by semantic key
- those artifacts remain non-authoritative until `MemoryCurator` later proposes
  them as `context_packet` inputs
- operator teaching does not write truth/task/ledger state directly

## Closure Loops

The cognitive architecture is evaluated as four explicit loops rather than a
bag of isolated features.

### 1. Sedimentation Loop

`execution -> boundary signal -> memory formation -> cognition artifact`

This loop answers: what survives a session and becomes future cognition input.

### 2. Rehydration Loop

`prompt/trigger -> memory curator -> context_packet proposal -> accepted context`

This loop answers: which non-authoritative artifacts are worth showing again.

### 3. Proactivity Loop

`heartbeat/schedule trigger -> proactivity engine -> wake plan/context -> memory curator -> wake prompt`

This loop answers: when intelligence wakes up and what it wakes up with.

### 4. Adaptation Loop

`cognitive metrics -> ranking/writer policy adjustments -> better future selection`

This loop answers: whether the cognitive layer improves from observed outcomes.
The current implementation persists a small control-plane policy at
`.brewva/cognition/adaptation.json`, updates it from
`cognitive_metric_rehydration_usefulness`, and feeds that policy back into
`MemoryCurator` ranking and `MemoryFormation` quality gates without changing
kernel authority.

## Outcomes And Metrics

The architecture is evaluated with outcome-oriented signals:

- `first_productive_action_turn_index`
  - emitted as `cognitive_metric_first_productive_action`
  - first turn whose tool result reaches a semantic `pass`
- `resumption_to_progress_turn_index`
  - emitted as `cognitive_metric_resumption_progress`
  - turns from session resume to first progress/evidence-bearing action
- `context_narrative_ratio`
  - emitted on `context_composed`
  - `narrative_tokens / total_composed_tokens`
- `rehydration_usefulness_rate`
  - emitted as `cognitive_metric_rehydration_usefulness`
  - whether accepted rehydrated memory leads to progress within the next two
    turns

These metrics are preferable to proxy signals such as raw tool-count reduction.
