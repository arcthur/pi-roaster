# Design Axioms

Brewva's kernel is defined by one constitutional line:

`Intelligence proposes. Kernel commits. Tape remembers.`

This document fixes the long-lived architectural taste behind that line so new
features can be judged against a stable standard instead of local convenience.

## Axioms

1. `Adaptive logic stays out of the kernel.`
   Ranking, planning, summarization, model routing, and heuristic inference may
   exist, but they belong to deliberation/control-plane layers.
2. `Proposal, not power.`
   Outer layers may submit proposals; they do not gain authority to mutate
   kernel state directly.
   Reserved built-in issuers must also obey their explicit boundary policy;
   they do not get hidden internal exemptions.
3. `Every commitment has a receipt.`
   Accept/reject/defer decisions must remain inspectable after the turn that
   produced them.
4. `Tape is commitment memory.`
   The event tape is not just a debug log. It is the replayable memory for what
   the system actually committed.
5. `Inconclusive is honest governance.`
   The system must be able to say "not enough evidence yet" without collapsing
   into a fake pass/fail binary.
6. `Graceful degradation beats hidden cleverness.`
   If a deliberation path fails, the kernel must stay safe and explainable
   rather than silently improvising new behavior.

## Ring Model

- `Kernel Ring`
  - commitment boundary
  - policy enforcement
  - tool/context/cost gates
  - verification
  - replay, WAL, checkpoint recovery
  - fail-closed behavior
- `Deliberation Ring`
  - candidate generation
  - ranking and planning
  - broker/judge/model orchestration
  - context curation
  - future multi-model reasoning flows
- `Experience Ring`
  - CLI, gateway, channels
  - operator UX
  - handoff artifacts
  - debug-loop controllers

The rings are about authority, not package names. Code may move across packages
over time; authority boundaries should not.

## Plane Model

Planes describe cross-cutting concerns that may read across rings without
gaining their authority:

- `Working State Plane`
  - projection
  - context arena
  - pending dispatch
  - active tool surface
- `Cognitive Product Plane`
  - context composition
  - memory formation
  - memory curation
  - persona/profile rendering
- `Control Plane`
  - broker, debug-loop, heartbeat, proactive wake context, scheduling triggers,
    future planners

Current module anchors:

- `Working State Plane`
  - `packages/brewva-runtime/src/context/*`
  - `packages/brewva-runtime/src/services/context*.ts`
  - `packages/brewva-runtime/src/projection/*`
  - `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
- `Cognitive Product Plane`
  - `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
  - `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`
  - `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
  - `packages/brewva-runtime/src/context/identity.ts`
- `Control Plane`
  - `packages/brewva-skill-broker/src/*`
  - `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts`
  - `packages/brewva-gateway/src/runtime-plugins/proactivity-context.ts`
  - `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts`
  - `packages/brewva-gateway/src/runtime-plugins/memory-adaptation.ts`
  - gateway heartbeat / scheduler policy code

Rings answer "who may commit". Planes answer "what concern is this code
serving".

Product rule:

`Model sees narrative. Operator sees telemetry. Kernel sees receipts.`

## Kernel Admission Rules

The kernel may:

- validate contracts
- accept, reject, or defer proposals
- arm gates
- create replayable state transitions
- emit receipts and tape evidence

The kernel may not:

- silently invent a proposal on behalf of a missing deliberation layer
- perform adaptive model-side ranking inside the commitment path
- treat lossy summaries as authoritative state
- hide commitment reasons behind opaque heuristics

## Package Realization

`@brewva/brewva-deliberation` now exists because those trigger conditions were
met:

- multiple proposal producers (`skill-broker`, `debug-loop`) already shared the
  same proposal/evidence mechanics
- proposal generation needs its own test surface without pulling kernel
  governance logic into every producer
- control-plane planning helpers now have a separate release and review axis
- external cognition artifacts and proposal-query projection now live outside
  the kernel instead of being improvised inside producer modules

The ring model still matters more than package count. A package split is only
useful when it protects authority boundaries instead of hiding them.
