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
  - persona/profile rendering
- `Control Plane`
  - broker, debug-loop, heartbeat, future planners, scheduling triggers

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
  - fallback: treat the full identity file as `WhoIAm` content when headings
    are absent

This plane may read kernel state, but it does not mutate kernel state directly.
All commitment changes still cross the proposal boundary.

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
  - prompt/artifact term overlap over `.brewva/cognition/reference/`
- summary resume
- open-loop resume

All strategies must converge through the same curator so they do not compete
silently for context budget.

## Proactivity

Proactivity belongs to the `Control Plane`, not the kernel.

Heartbeat, scheduler rules, broker triggers, and debug-loop retries may wake
intelligence up, but they still produce proposals or durable artifacts instead
of implicit kernel mutations.

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
