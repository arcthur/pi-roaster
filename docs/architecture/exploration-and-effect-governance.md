# Exploration And Effect Governance

This document fixes Brewva's governing philosophy and architecture for
contract, tool-governance, deliberation, and control-plane design.

It does not replace the constitution. It refines that constitution at the
implementation granularity now used across the runtime.

## Constitutional Reading

The current constitution still stands:

`Intelligence proposes. Kernel commits. Tape remembers.`

The implementation-grade constitutional reading is:

`Intelligence explores. Kernel authorizes effects. Tape remembers commitments.`

These two lines describe the same boundary from two angles:

- `proposes / explores` means the model and the control plane discover paths
  rather than hold authority directly
- `commits / authorizes effects` means the kernel governs commits and world
  changes rather than the reasoning path itself
- `Tape remembers / remembers commitments` means the system remembers committed
  facts rather than every intermediate thought

Implementation notes:

- the runtime now uses explicit `effects`, `resources`, and lease negotiation
  as the primary governance path
- the visible tool surface and execution hints still help the model search, but
  they do not define the authority boundary on their own
- a small set of runtime-owned control-plane tools remains explicitly exempted
  for recovery and negotiation; those exceptions must stay narrow and auditable

## Core Principle

The governance principle is:

`Govern what may happen to the world, not how the model searches for a path.`

In other words:

- the kernel constrains effect boundaries, commit boundaries, verification
  boundaries, and replay boundaries
- deliberation optimizes search paths, decomposition, retry strategy, and
  context restructuring
- the control plane handles dynamic negotiation across cost, risk, and latency

The following two problem classes should no longer be collapsed into one hard
contract:

- `Intent / Effect`
  - what the task should produce
  - what impact on the world is allowed or forbidden
- `Path / Resource Guess`
  - which tools to try first
  - how many tokens or steps the run may roughly consume

The former is governance. The latter is planner work.

## Two Lanes

The system recognizes two distinct lanes.

### `exploration lane`

Used for:

- path search
- hypothesis generation and self-correction
- draft planning, shadow execution, and low-risk probing
- dynamic negotiation of tools and resources

Properties:

- non-authoritative
- discardable
- freer to rearrange context and explore alternate paths
- allowed to use heuristics, ranking, judging, memory rehydration, and
  temporary packets

### `commitment lane`

Used for:

- real tool execution
- observable side effects
- artifact submission
- verification, receipts, ledger writes, and tape durability

Properties:

- authoritative
- auditable
- replayable
- able to answer why a given change was authorized

The lanes must connect only through explicit boundary crossings such as
proposals, leases, receipts, and effect authorization. Hidden runtime fallback
must not blur the line.

## Contract Split

Contracts are split into four layers instead of packing every concern into
`SkillContract`.

### `IntentContract`

Describes the definition of completion for a task:

- target artifacts
- output format and quality bars
- completion conditions
- required verification evidence

### `EffectContract`

Describes what side effects are allowed:

- allowed effect classes
- forbidden world-state changes
- effect-denial boundaries that cannot be relaxed by overlays or config

### `ResourcePolicy`

Describes resource boundaries, but should distinguish between:

- kernel hard ceilings
- control-plane soft defaults
- temporary leases that deliberation may request

Resource policy should not default to a skill author's prewritten execution
path.

### `ExecutionHints`

Describes empirical guidance rather than authority:

- preferred tools
- suggested chains
- historical priors
- cost estimates
- convergence guidance

This information should serve brokers, planners, debug loops, and future
orchestrators rather than directly becoming kernel commit conditions.

## Governance Style

The governance style moves from “predefined path” to
“authorize effects plus negotiate resources.”

That implies:

- `denied` is closer to true governance semantics than `required`
- `tool name` is an effect carrier, not an authority primitive
- `required tools` are planner hints, not authority fields
- `per-skill maxToolCalls / maxTokens` are default leases, while real hard
  ceilings come from session or global policy
- when resources are insufficient, the system should prefer lease negotiation
  over flattening every exploratory impulse into a hard failure

Governance becomes more like a dialogue:

- intelligence explains why additional budget is needed, or why a different
  commitment boundary should be proposed
- the control plane evaluates risk and value
- the kernel authorizes or rejects only at the effect and commit boundary

Current implementation note:

- `resource_lease` is budget-only and active-skill-scoped
- it may expand resource ceilings with a receipt
- it does not widen effect authorization

## Tool And Governance Model

Authority should not be based primarily on static tool allowlists. It should be
based on effect classes and explicit governance boundaries such as resource
ceilings.

Examples of higher-value governance targets include:

- whether workspace reads are allowed
- whether workspace writes are allowed
- whether local command execution is allowed
- whether network access is allowed
- whether external system interaction is allowed
- whether secret or high-value data access is allowed
- whether future scheduling intents may be created

The tool layer still matters, but it should answer how an effect is carried,
not single-handedly define what world changes are allowed.

Current implementation note:

- managed Brewva tools now expose effect governance metadata on the tool
  definition object itself as a canonical view over exact managed-tool policy
- the default gateway/runtime path imports that descriptor metadata before
  relying on registry lookup
- managed tool disclosure may use execution hints for prioritization
- the visible skill-oriented surface still includes managed tools whose known
  effect descriptors are authorized by the current effect contract

## Verification Consequences

Verification should align with the same principle:

- prioritize artifact quality, effect legality, post-write evidence, and
  rollback viability
- avoid turning verification into a rigid process template
- allow different paths to converge on the same completion definition

This does not weaken verification. It makes verification target the thing that
actually needs to be trusted.

## Non-goals

This architecture does not mean:

- turning the kernel into an adaptive planner
- removing all budget and resource ceilings
- replacing pre-authorization with post-hoc audit
- deleting current tool gating in one step
- allowing the model to expand authority without receipts

## Related Documents

- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/proposal-boundary.md`
- `docs/research/rfc-effect-governance-and-contract-vnext.md`
