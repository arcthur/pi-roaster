# Reference: Skills

Skill parsing, merge, and selection logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/dispatch.ts`
- `packages/brewva-extensions/src/context-transform.ts`

## Contract Metadata

Skill frontmatter supports dispatch-focused metadata:

- `dispatch.gate_threshold/auto_threshold/default_mode` for routing policy
- `outputs/consumes/composable_with` for deterministic chain planning

Selector execution is governance-first for runtime routing:

1. Runtime kernel routing is deterministic and contract-aware when `skills.selector.mode=deterministic`.
2. Explicit preselection (for example control-plane `setNextSelection`) is consumed before runtime routing and wins when present.
3. Routing telemetry keeps `skill_routing_translation` as deterministic `skipped` because there is no model translation stage; `skill_routing_semantic` reflects `selected | empty | failed` from the deterministic router.
4. `skills.selector.mode=external_only` disables kernel routing and keeps explicit preselection as the only selection source.
5. Activation remains explicit: routing may produce `suggest/gate/auto` dispatch decisions, but actual skill entry still happens through `skill_load`.
6. Runtime does not run adaptive inference loops or online model reranking in the kernel path.

`skills_index.json` now carries normalized contract metadata for each skill entry (including `outputs`, `consumes`, and `dispatch`).

## Cascade Orchestration

Skill cascading is policy-driven via `skills.cascade.*`:

- `mode=off`: no automatic cascade behavior
- `mode=assist`: runtime records/plans chains but waits for manual continuation
- `mode=auto`: runtime auto-advances to next steps after `skill_completed` events

Chain intent can come from dispatch planning (`outputs/consumes/composable_with`) or compose output (`skill_sequence`).
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
