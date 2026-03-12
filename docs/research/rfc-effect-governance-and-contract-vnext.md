# Research: Effect Governance and Contract vNext

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-12`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`

This note is now a migration and rationale record. The architecture and runtime
surfaces described here have been promoted into stable docs and implemented in
the current runtime.

## Problem Statement And Scope

The current `SkillContract` carries two fundamentally different kinds of
responsibility:

- `intent / effect governance`
  - define task artifacts
  - define allowed and forbidden side effects
  - define the completion definition
- `path / resource prescription`
  - recommend or mandate specific tools
  - estimate or cap tokens, tool calls, and parallelism

That mix can improve convergence on complex engineering tasks, but over time it
creates three problems:

1. Skill authoring becomes too heavy
   - even simple automations require a relatively heavy contract up front
2. LLM path-finding is constrained too early
   - the runtime can mistake tool allowlists and budgets for the true
     governance boundary
3. Governance remains stuck at the `tool name` level
   - it cannot precisely express what world changes are allowed

The goal of this RFC is not to weaken the kernel. It is to move governance
gradually from `process proxy` to `effect boundary`.

Explicitly out of scope:

- putting adaptive planning into the kernel
- removing receipt, replay, verification, or WAL
- replacing pre-authorized effects with post-hoc audit
- deleting current skill tool gating in one step

## Direct Conclusion

Implemented direction: the effect-governed hybrid model.

- keep kernel authority intact
- split `SkillContract` into `intent`, `effects`, `resource policy`, and
  `execution hints`
- demote `required/optional tools` from hard contract fields to planner hints
- demote per-skill budgets from default hard gates to soft defaults plus lease
  negotiation
- introduce tool effect metadata so the runtime can eventually govern
  capability/effect classes rather than only tool names

## Why This Direction

This direction follows directly from Brewva's adopted constitutional reading:

- `Intelligence proposes` means path discovery should not be prewritten by the
  kernel
- `Kernel commits` means authority should sit on effect authorization and commit
  semantics
- `Tape remembers` means the auditable object should be commitments rather than
  all planner intermediate guesses

More concretely:

- `outputs` and `outputContracts` are closer to true governance semantics
- `effectLevel` remains useful only as a derived summary of `allowedEffects`
- `tools.required`, `tools.optional`, `budget.maxToolCalls`, and
  `budget.maxTokens` are closer to planner priors
- `tools.denied` is an important transitional control, but over time it should
  also be absorbed by higher-level effect classes

## Current Pressure Points

Current pressure concentrates around these implementation anchors:

- `packages/brewva-runtime/src/types.ts`
  - `SkillContract` puts outputs, tool policy, and budget on the same layer
- `packages/brewva-runtime/src/security/tool-policy.ts`
  - access decisions are driven mainly by `tool name` and allowlists
- `packages/brewva-runtime/src/services/tool-gate.ts`
  - combines tool access, budget, and context gates, making it sensitive to
    path prescription
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
  - completion depends heavily on skill-scoped outputs and verification
- `packages/brewva-runtime/src/governance/tool-governance.ts`
  - effect descriptors are now first-class, but still live in a registry rather
    than inline with every tool definition

## Proposed Contract Model

The current `SkillContract` should be split into the following semantic layers.

```ts
export interface IntentContract {
  outputs?: string[];
  outputContracts?: Record<string, SkillOutputContract>;
  completionDefinition?: {
    verificationLevel?: VerificationLevel;
    requiredEvidenceKinds?: string[];
  };
}

export interface EffectContract {
  allowedEffects?: ToolEffectClass[];
  deniedEffects?: ToolEffectClass[];
}

export interface ResourcePolicy {
  hardCeiling?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxParallel?: number;
  };
  defaultLease?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxParallel?: number;
  };
}

export interface ExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
  suggestedChains?: Array<{ steps: string[] }>;
  costHint?: "low" | "medium" | "high";
}

export interface SkillContractVNext {
  intent: IntentContract;
  effects: EffectContract;
  resources?: ResourcePolicy;
  executionHints?: ExecutionHints;
}
```

The most important part of this split is not the field names. It is the shift
in authority ownership:

- `intent` and `effects` enter kernel governance semantics
- only the hard-ceiling portion of `resources` belongs to the kernel
- `executionHints` explicitly serves the deliberation and control plane

## Tool Metadata Direction

If the runtime is going to govern `effect` over time, tool definitions must
first expose effect metadata.

The implemented direction uses a descriptor like:

```ts
export type ToolEffectClass =
  | "workspace_read"
  | "workspace_write"
  | "local_exec"
  | "network_access"
  | "external_side_effect"
  | "secret_access"
  | "schedule_mutation";

export interface ToolGovernanceDescriptor {
  effects: ToolEffectClass[];
  defaultRisk?: "low" | "medium" | "high";
}
```

That allows `ToolGateService` to evolve from:

- "Does this skill allow `exec`?"

to:

- "Is this turn currently authorized to perform `local_exec` or
  `external_side_effect`?"

## Resource Negotiation Direction

Over time, budgets should not continue to be hard-coded directly into skill
frontmatter.

The more appropriate layering is:

- session / global hard ceilings
  - kernel authority
- skill or profile default lease
  - planner default budget
- temporary capability or resource lease
  - an explicit negotiation result triggered by deliberation or an operator

`resource_lease` is now the current name for temporary budget expansions such as:

- additional tokens, tool calls, or parallel slots

Such leases must:

- have a TTL or turn window
- be receipt-bearing
- stay scoped to the active skill
- support rejection or downgrade

## Options Considered

### Option A: Keep Current Mixed Contract

Approach:

- keep `SkillContract` as is
- only adjust defaults and overlay ergonomics

Pros:

- minimal change surface
- no new tool metadata required

Cons:

- authoring cost improves only marginally
- authority remains anchored to `tool name`
- planner priors continue to harden into governance over time

### Option B: Fully Post-hoc Governance

Approach:

- execute freely first
- verify and audit only after the fact

Pros:

- maximizes model freedom

Cons:

- directly weakens the kernel promise
- makes replayable effect authorization difficult to preserve
- is unacceptable for high-risk side effects

### Option C: Effect-governed Hybrid

Approach:

- keep the kernel strong
- make deliberation thicker
- migrate authority from `tool/process` toward `effect/result`

Pros:

- preserves the trustworthy commit model
- releases more path-finding ability
- supports incremental migration

Cons:

- requires tool effect metadata
- originally required a short migration window while the old contract shape was removed

Adopted option: `Option C`

## Migration Record

### Phase 0: Documentation And Terminology

- fix constitutional and authority-boundary language in `docs/architecture/`
- fix contract split, tool metadata, and lease language in this research RFC
- align terminology before the runtime cutover

### Phase 1: Add Tool Effect Metadata

- add a governance descriptor at the tool-definition layer
- keep early gate outcomes stable long enough to compare telemetry and
  validation
- establish a stable `tool -> effect classes` mapping

### Phase 2: Dual-path Governance Evaluation

- `ToolGateService` should compute both:
  - current tool-policy decision
  - effect-policy preview decision
- record the diff in telemetry to detect false blocks or false allowances

### Phase 3: Degrade Process Fields Into Hints

- turn `required/optional tools` into recommendation-oriented fields
- keep the current allowlist first in warning mode or compatibility mode
- have planner, broker, and debug loop consume hints before hard gates

### Phase 4: Introduce Leases

- add `resource_lease` or an equivalent receipt-bearing flow
- allow temporary expansion of resource scope inside a bounded window
- keep leases out of effect authorization so they cannot self-escalate tool authority

### Phase 5: Shrink Public Contract Surface

- promote `SkillContractVNext` in reference docs
- remove the superseded process-heavy fields from the stable contract
- remove unnecessary tool-name-centered config

## Validation Signals

We need to track authoring cost, released agent capability, and safety in
parallel.

### Authoring Signals

- the average number of fields needed to take a new skill from draft to runnable
  decreases
- simple automations no longer require hand-written full tool allowlists
- the primary role of project overlays shifts from “add tools” to “add effect
  and intent semantics”

### Agent Behavior Signals

- the rate of `tool_call_blocked` events caused by process mismatch decreases
- completion rate improves or at least does not regress on the same task set
- self-correction rounds increase without increasing total failure rate

### Safety Signals

- the block rate for unauthorized effects does not decline
- verification pass quality does not decline
- rollback, ledger, receipt, and proposal replay semantics remain stable

## Open Questions

Questions that remain relevant after implementation:

1. Should tool effect metadata live directly on tool definitions, or in a
   separate registry for better adapter compatibility?
2. How should `security.enforcement.*` migrate without breaking current modes
   while keeping the config vocabulary aligned with effect governance?

## Source Anchors

- `packages/brewva-runtime/src/types.ts`
- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
- `packages/brewva-tools/src/utils/tool.ts`
- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/skills.md`
- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/reference/tools.md`

## Promotion Outcome

This RFC has already been promoted into stable docs and implementation
commitments. The migration conditions that were used during rollout were:

1. at least one round of tool effect metadata was implemented and validated with
   telemetry
2. dual-path governance showed that current safety invariants were not weakened
3. the lease-flow authority model was defined and passed replay/recovery design
   review
4. the skill corpus was cut over to the new contract without a compatibility
   layer

## Stable Destinations

The stable destinations are:

- `docs/architecture/exploration-and-effect-governance.md`
  - constitutional and authority boundary
- `docs/reference/skills.md`
  - contract shape and overlay semantics
- `docs/reference/tools.md`
  - tool governance descriptor
- `docs/reference/runtime.md`
  - runtime surfaces and lease semantics
- `docs/reference/configuration.md`
  - current policy/config semantics
