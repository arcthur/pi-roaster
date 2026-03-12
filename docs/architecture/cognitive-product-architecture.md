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

Planes may span rings. For example, context composition reads kernel-approved
working state, deliberation artifacts, and current tool surface, then emits a
model-facing view through experience hooks.

## Core Principle

The product rule is:

`Model sees narrative. Operator sees telemetry. Kernel sees receipts.`

Implementation-grade principle:

`Deliberation explores. Commitment authorizes effects.`

Consequences:

- kernel state remains authoritative and replayable
- operator telemetry does not become default model context
- model-facing context is composed from admitted sources, not from raw runtime
  dashboards

Implementation note:

- the runtime now uses `intent`, `effects`, `resources`, and
  `execution_hints` as the main skill contract split
- visible tool surface and execution hints still shape exploration
- kernel authority remains at effect, commit, verification, and replay
  boundaries
- a few runtime-owned control-plane exceptions remain explicit rather than
  hidden

## Exploration Lane And Commitment Lane

The product architecture explicitly distinguishes two lanes.

### `exploration lane`

Responsibilities:

- discover paths
- probe different tool combinations
- generate or revise plans
- request additional context, a different commitment surface, or more budget
  without self-authorizing new effects

Allowed artifacts:

- draft plans
- broker traces
- cognition artifacts
- temporary `context_packet` material
- lease requests

These artifacts may make the model more effective, but they are not kernel
authority by default.

### `commitment lane`

Responsibilities:

- execute authorized effects
- record receipts, ledger entries, and verification evidence
- preserve replayable durability

This lane must answer:

- whether the effect is authorized
- whether the commit satisfies the completion definition
- whether failure can be explained and recovered from

The point of separating the lanes is not to fragment the system. It is to avoid
having the kernel prescribe thought paths as a side effect of enforcing safety.

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
  - persists only latest-wins session summaries on the default path
  - captures resumable state at session boundaries instead of promoting it into
    kernel truth/task state
  - stamps summaries with `session_scope` so resumable state stays bound to the
    target live session

This plane may read kernel state, but it does not mutate kernel state directly.
Deliberation artifacts still cross the proposal boundary. Budget negotiation
may also cross through explicit receipt-bearing governance flows such as
`resource_lease`.

Over time, the cognitive plane should carry more “thick deliberation”
capabilities, such as:

- intermediate representations for path search
- low-risk shadow planning
- dialogue material for resource negotiation and commitment-boundary changes
- execution hints targeted to the current objective rather than hard contracts

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

Current direction:

- context composition should prioritize exploration continuity for the model
- constraint blocks should focus on effect boundaries, completion definitions,
  and anomaly diagnostics
- default narrative should not be overloaded with tool-path prescriptions that
  force the model into a fixed script

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
- summary resume
  - trigger-aware query expansion may add heartbeat objective/hints before local
    ranking runs

Storage and retrieval are intentionally not one-to-one:

- storage lanes:
  - `reference`
  - `summaries`
- retrieval strategies:
  - `reference`
  - `summary`

Current mapping:

- `reference` lane -> `reference`
- `summaries` lane -> latest same-session `summary`

Scope model is intentionally split:

- workspace-scoped cognition knowledge
  - `reference`
- session-scoped process memory
  - `summary`

Stable knowledge may travel across sessions in the same workspace. Resumable
process state stays bound to the target live session through `session_scope`.

This is an intentional design rule:

`storage authority != retrieval semantics`

The kernel only needs two storage roots. The default curator stays intentionally
small instead of rebuilding a large retrieval taxonomy.

All strategies must converge through the same curator so they do not compete
silently for context budget.

## Memory Formation Boundary

`MemoryFormation` is the write-side counterpart to `MemoryCurator`.

Responsibilities:

- observe session-boundary and phase-boundary signals such as `agent_end`,
  `session_compact`, and `session_shutdown`
- write replay-independent cognition summaries into
  `.brewva/cognition/summaries/`
- record non-authoritative resumable fields such as `phase`, `next_action`,
  `blocked_on`, and recent completed skill outputs
- apply control-plane quality guidance before persisting low-signal summaries
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
    same-session summary signals before `MemoryCurator` runs

`ProactivityEngine` remains control-plane only:

- it may inspect cognition artifacts and trigger metadata

This should also include:

- negotiation for temporary resource leases
- scheduling for exploration-lane convergence
- creating more room for self-correction without expanding kernel authority
- it may emit replayable wake and skip telemetry
- it may not mutate kernel state or bypass proposal admission

## Memory Quality Governance

Memory quality governance also belongs to the `Control Plane`.

Current module anchors:

- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`
- `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts`

This loop now has two effects:

- retrieval-side
  - `MemoryCurator` keeps default rehydration limited to `reference` plus the
    latest same-session summary
- formation-side
  - `MemoryFormation` only persists a summary when the semantic session summary
    changed

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
- default rehydration only consumes `reference` artifacts plus the latest
  same-session summary; `procedure` and `episode` stay operator-facing unless a
  future explicit policy promotes them

## Closure Loops

The cognitive architecture is evaluated as three explicit loops rather than a
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
