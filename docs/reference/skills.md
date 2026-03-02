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

Selector execution is LLM-first for runtime routing:

1. step-0 routing translation runs before injection/dispatch: user prompt is translated to English by the active model in `before_agent_start`; on translation failure or empty output, runtime falls back to the original prompt
2. semantic skill routing runs immediately after translation using the active model and skill catalog metadata (`name/description/outputs/consumes`); the resulting `selected` skills are injected into runtime as the next dispatch input
3. runtime dispatch consumes that semantic selection directly (no lexical fallback in this path)
4. lexical selector and `runtime.skills.select` are removed; runtime dispatch now consumes semantic preselection only

`skills_index.json` now carries normalized contract metadata for each skill entry (including `outputs`, `consumes`, and `dispatch`).

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
- `review`
- `tdd`
- `verification`

## Pack Skills

- `agent-browser`
- `frontend-design`
- `gh-issues`
- `github`
- `skill-creator`
- `telegram-interactive-components`

## Project Skills

- `brewva-project`
- `brewva-self-improve`
- `brewva-session-logs`

## Project Skill Notes

- `brewva-project` orchestrates source-lane analysis, process-evidence diagnosis,
  and delivery flows for runtime-facing work in this monorepo.
- `brewva-session-logs` provides artifact-centric inspection across event store,
  evidence ledger, memory, snapshots, cost traces, and schedule projections.
- `brewva-self-improve` captures reusable learnings and errors, then promotes
  validated patterns into durable assets such as `AGENTS.md`, skills, and docs.

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
