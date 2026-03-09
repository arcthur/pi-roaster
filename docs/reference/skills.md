# Reference: Skills

Skill parsing, merge, and selection logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/dispatch.ts`
- `packages/brewva-extensions/src/context-transform.ts`

## Contract Metadata

Skill frontmatter supports dispatch-focused metadata:

- `dispatch.gate_threshold/auto_threshold/default_mode` for routing policy
- `outputs/requires/consumes/composable_with` for deterministic chain planning
- `effect_level` for planner safety (`read_only | execute | mutation`)

Selector execution is governance-first for runtime routing:

1. Runtime kernel routing is deterministic and contract-aware when `skills.selector.mode=deterministic`.
2. Explicit preselection (for example control-plane `setNextSelection`) is consumed before runtime routing and wins when present.
3. Routing telemetry emits `skill_routing_selection` and reflects the final runtime routing result (`selected | empty | failed`), plus `skipped` under the critical compaction gate, whether the source was the deterministic router or external preselection.
4. `skills.selector.mode=external_only` disables kernel routing and keeps explicit preselection as the only selection source.
5. Activation remains explicit: routing may produce `suggest/gate/auto` dispatch decisions, but actual skill entry still happens through `skill_load`.
6. Runtime does not run adaptive inference loops or online model reranking in the kernel path.

## Kernel vs Control Plane

The runtime kernel and the optional control plane have different jobs:

- kernel/runtime: deterministic routing (`deterministic` mode), dispatch gates,
  evidence, replay, and policy enforcement
- control plane: optional preselection assistance such as the external catalog
  broker and its lexical or `llm` judge

When the broker path is enabled, runtime is forced to `external_only` and
consumes explicit preselection as an input. The model-assisted judge therefore
does not make the kernel "smarter"; it is a separate control-plane assist path.

Session bootstrap currently installs the external control-plane broker before the runtime extension stack.
That means CLI/gateway turns normally arrive at runtime as `external_preselection`.
The current broker is two-stage:

- stage 1: catalog shortlist from `.brewva/skills_index.json`
- stage 2: candidate preview judge using the shortlisted skills' `Intent` / `Trigger` / boundary sections, or a control-plane `pi-ai complete()` judge when `skills.selector.brokerJudgeMode=llm`

The default broker judge mode is `llm`.
When lexical shortlist confidence is low or empty, the broker can ask the control-plane judge to evaluate the catalog candidate set directly using the current session model and `ctx.modelRegistry.getApiKey(...)`.
`llm` mode is authoritative: if model resolution, credentials, or parsing fail, broker routing is marked failed instead of silently falling back to lexical heuristic.
Use `skills.selector.brokerJudgeMode=heuristic` only when you explicitly want lexical-only routing.

Broker-enabled sessions are forced to `skills.selector.mode=external_only`, so runtime kernel selection is closed off and the runtime remains governance-only for dispatch, gate, and replay semantics.

`skills_index.json` now carries normalized contract metadata for each skill entry (including `outputs`, `requires`, `consumes`, `effectLevel`, and `dispatch`).

## Cascade Orchestration

Skill cascading is policy-driven via `skills.cascade.*`:

- `mode=off`: no automatic cascade behavior
- `mode=assist`: runtime records/plans chains but waits for manual continuation
- `mode=auto`: runtime auto-advances to next steps after `skill_completed` events

Dispatch planning uses only `requires` as hard prerequisites; `consumes` remain optional context for loading/scoring.
Chain intent can come from dispatch planning (`outputs/requires/consumes/composable_with`) or compose output (`skill_sequence`).
Source arbitration uses:

- `skills.cascade.enabledSources` as allowlist
- `skills.cascade.sourcePriority` as ordering for enabled sources

Runtime records cascade lifecycle as replayable events:

- `skill_cascade_planned`
- `skill_cascade_step_started`
- `skill_cascade_step_completed`
- `skill_cascade_paused`
- `skill_cascade_replanned`
- `skill_cascade_overridden`
- `skill_cascade_finished`
- `skill_cascade_aborted`

When step consumes are missing, cascade deterministically pauses (`reason=missing_consumes`).
Runtime no longer injects auto-replan branches into the chain.

When cascade source arbitration occurs (for example compose vs dispatch), runtime
emits `sourceDecision` in cascade event payloads with stable reason codes:

- `no_existing_intent`
- `incoming_source_disabled`
- `existing_source_disabled`
- `existing_terminal`
- `existing_running_active_skill`
- `explicit_source_locked`
- `incoming_source_not_configured`
- `existing_source_not_configured`
- `incoming_same_unconfigured_source`
- `incoming_higher_or_equal_priority`
- `incoming_lower_priority`

## Base Skills

- `brainstorming`
- `cartography`
- `compose`
- `debugging`
- `execution`
- `exploration`
- `finishing`
- `git`
- `patching`
- `planning`
- `recovery`
- `review`
- `tdd`
- `verification`

## Pack Skills

- `agent-browser`
- `frontend-design`
- `goal-loop`
- `gh-issues`
- `github`
- `skill-creator`
- `telegram-channel-behavior`
- `telegram-interactive-components`

## Project Skills

- `brewva-project`
- `brewva-self-improve`
- `brewva-session-logs`

## Project Skill Notes

- `brewva-project` orchestrates source-lane analysis, process-evidence diagnosis,
  and delivery flows for runtime-facing work in this monorepo.
- `brewva-session-logs` provides artifact-centric inspection across event store,
  evidence ledger, working projection, snapshots, cost traces, and schedule projections.
- `brewva-self-improve` captures reusable learnings and errors, then promotes
  validated patterns into durable assets such as `AGENTS.md`, skills, and docs.

## Loop and Recovery Notes

- `goal-loop` is the runtime-native iterative delivery pack skill. It declares
  scheduled convergence intent through `schedule_intent` rather than simulating
  repetition inside prompt text.
- `recovery` is the bounded unhappy-path companion skill. It converts repeated
  failures, convergence guard pressure, or plan-reality mismatch into explicit
  evidence, a short recovery plan, and a clean next-skill handoff.

## `brewva-project` Contract Focus

- Baseline tools stay read-first: `read`, `grep`.
- Optional tools are aligned with the `@brewva/brewva-tools` runtime surface
  (LSP, AST, process, ledger/tape/cost, schedule, task ledger, skill lifecycle tools).
- Generic mutation-only tools (`write`, `edit`) remain intentionally excluded;
  code changes are delegated to specialized skills such as `patching`.

## Storage Convention

- `skills/base/<skill>/SKILL.md`
- `skills/packs/<pack>/SKILL.md`
- `skills/project/<skill>/SKILL.md`

Runtime discovery also accepts roots provided via `skills.roots` and executable
sidecar assets. See `docs/reference/configuration.md` (Skill Discovery).
