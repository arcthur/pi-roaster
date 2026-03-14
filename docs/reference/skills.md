# Reference: Skills

Skill parsing, merge, and selection logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/dispatch.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`

## Current Model

Skill taxonomy is now split by role:

- public routable skills: routable semantic territory
- runtime/control-plane phases: workflow semantics, not public skills
- project overlays: project-specific tightening, execution guidance, and shared-context extension
- operator/meta skills: loaded, but usually hidden from standard routing

This keeps lifecycle choreography out of the public catalog.

Automatic debug retry is now implemented as an extension-side controller that
reuses explicit cascade intents plus runtime verification outcomes; it is not a
public skill and not a runtime-kernel planner.

## Contract Metadata

Skill frontmatter supports intent, effect, resource, and execution metadata:

- `dispatch.suggest_threshold/auto_threshold`
- `intent.outputs/intent.output_contracts`
- `effects.allowed_effects/effects.denied_effects`
- `resources.default_lease/resources.hard_ceiling`
- `execution_hints.preferred_tools/execution_hints.fallback_tools/execution_hints.cost_hint`
- resource lists: `references`, `scripts`, `heuristics`, `invariants`

For non-overlay skills:

- both `resources.default_lease` and `resources.hard_ceiling` are required
- `resources.hard_ceiling` must stay greater than or equal to
  `resources.default_lease`
- `effects.allowed_effects: []` is treated as an explicit zero-effect boundary,
  not as implicit read-only fallback

Directory layout derives category and routing scope:

- `skills/core/*` -> `category=core`, `routing.scope=core`
- `skills/domain/*` -> `category=domain`, `routing.scope=domain`
- `skills/operator/*` -> `category=operator`, `routing.scope=operator`
- `skills/meta/*` -> `category=meta`, `routing.scope=meta`
- `skills/internal/*` -> internal only, not routable
- `skills/project/overlays/*` -> overlay only, not routable

`tier` and `category` frontmatter are rejected. Category is directory-derived.

Non-overlay skill names must be globally unique across all loaded roots and
categories. Same-name specialization belongs in `skills/project/overlays/*`,
not in a second base skill definition that relies on load order.

`skills/internal/` is currently a reserved documentation slot for runtime-owned
phases. Verification, finishing, recovery, and compose-style planning live in
runtime/control-plane code today rather than structured `SKILL.md` documents.

`intent.output_contracts` makes artifact quality explicit in the skill contract
instead of hiding it inside runtime heuristics. Non-overlay skills with
declared outputs must define a contract for every output. Overlays may inherit
base output contracts, but they cannot silently replace an existing base output
contract.

Current output contract kinds are intentionally limited to `text`, `enum`, and
`json`.

## Routing Scopes And Profiles

Skill discovery and deliberation are now separated from kernel commitment:

1. Deliberation layers may rank skills, judge candidates, and build chains.
2. The kernel accepts only proposals that cross an admission boundary (`skill_selection`, `context_packet`, `effect_commitment`).
3. Proposal telemetry still emits `skill_routing_selection` as a projection of the latest accepted/deferred selection outcome (`selected | empty | failed | skipped`).
4. Activation remains explicit: accepted proposals may arm `suggest/auto` dispatch decisions, but actual skill entry still happens through `skill_load`.
5. Runtime does not run adaptive inference loops or online model reranking in the kernel path.

Routing is disabled by default (`skills.routing.enabled=false`). When enabled,
`skills.routing.scopes` is the single explicit routing allowlist.

## Kernel vs Control Plane

The runtime kernel and the optional control plane have different jobs:

- kernel/runtime: dispatch commitments, evidence, replay, policy enforcement, and proposal commitment
- control plane: optional candidate generation, selection assistance, chain planning, and model-assisted judging

When the broker path is enabled, it submits explicit proposals into the kernel
boundary. The model-assisted judge therefore does not make the kernel
"smarter"; it is a separate deliberation/control-plane path.

`skills_index.json` carries normalized contract metadata for each routable skill
entry, including `category`, `routingScope`, `outputs`, `requires`, `consumes`,
derived `effectLevel`, `allowedEffects`, and `dispatch`.

## Cascade Orchestration

Skill cascading is policy-driven via `skills.cascade.*`:

- `mode=off`: no automatic cascade behavior
- `mode=assist`: runtime records/plans chains but waits for manual continuation
- `mode=auto`: runtime auto-advances to next steps after `skill_completed` events

Chain intent can come from:

- explicit `startCascade(...)` / `skill_chain_control`
- broker-owned or extension-owned direct cascade starts

Source arbitration uses:

- `skills.cascade.enabledSources` as allowlist
- `skills.cascade.sourcePriority` as ordering for enabled sources

Current built-in sources are only `dispatch` and `explicit`.

Runtime records cascade lifecycle as replayable events:

- `skill_cascade_planned`
- `skill_cascade_step_started`
- `skill_cascade_step_completed`
- `skill_cascade_paused`
- `skill_cascade_replanned`
- `skill_cascade_overridden`
- `skill_cascade_finished`
- `skill_cascade_aborted`

When step consumes are missing, cascade deterministically pauses
(`reason=missing_consumes`). Runtime no longer supports compose-originated chain
plans as a public source.

The debug loop reuses explicit cascade rather than introducing a second step
engine. Its failure snapshot and handoff packet are extension-owned artifacts,
not public skill outputs. The latest retry/handoff summary may also be mirrored
into Deliberation-side cognition artifacts and cross back as a scoped
`context_packet`, but it still remains non-authoritative context rather than
skill output or kernel state.

## Public Routable Skills

### Core

- `repository-analysis`
- `design`
- `implementation`
- `debugging`
- `review`

### Domain

- `agent-browser`
- `frontend-design`
- `github`
- `telegram`
- `structured-extraction`
- `goal-loop`

`goal-loop` should be treated as a bounded multi-run skill, not a
general-purpose implementation skill.

## Hidden-By-Default Skills

### Operator

- `runtime-forensics`
- `git-ops`

### Meta

- `skill-authoring`
- `self-improve`

These skills are loaded by the registry but excluded from standard routing
unless routing scopes explicitly include them.

## Project Overlays

- `repository-analysis`
- `design`
- `implementation`
- `debugging`
- `review`
- `runtime-forensics`

Overlays merge onto the base skill contract with project semantics:

- intent outputs merge additively with the base contract
- output contracts remain base-derived unless the overlay adds a brand-new output
- completion definitions merge field-by-field, so overlays may tighten
  `verification_level` without silently dropping inherited
  `required_evidence_kinds`
- allowed effects may tighten, and denied effects only accumulate
- resource ceilings and default leases only tighten, never relax
- execution hints may specialize planning guidance without changing kernel authority
- multiple overlays apply in deterministic root load order; within one root,
  overlay files are applied in lexical path order, and later overlays only
  tighten or replace fields according to the merge contract

Config-layer `skills.overrides` remain tightening-only. Shared project context is
prepended from:

- `critical-rules`
- `migration-priority-matrix`
- `package-boundaries`
- `runtime-artifacts`

## Storage Convention

- `skills/core/<skill>/SKILL.md`
- `skills/domain/<skill>/SKILL.md`
- `skills/operator/<skill>/SKILL.md`
- `skills/meta/<skill>/SKILL.md`
- `skills/internal/<skill>/SKILL.md`
- `skills/project/shared/*.md`
- `skills/project/overlays/<skill>/SKILL.md`

Runtime discovery also accepts roots provided via `skills.roots`. A discovered
root may either contain a nested `skills/` directory or the category directories
directly.
