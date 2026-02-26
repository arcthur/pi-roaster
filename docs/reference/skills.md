# Reference: Skills

Skill parsing, merge, and selection logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/selector.ts`

## Base Skills

- `cartography`
- `compose`
- `debugging`
- `exploration`
- `git`
- `patching`
- `planning`
- `review`
- `verification`

## Pack Skills

- `agent-browser`
- `frontend-ui-ux`
- `gh-issues`
- `github`
- `skill-creator`
- `telegram-interactive-components`

## Project Skills

- `brewva-project`

## `brewva-project` Contract Notes

- Baseline tools stay read-first: `read`, `grep`.
- Optional tool contract is aligned with `@brewva/brewva-tools` runtime surface
  (LSP, AST, process, ledger/tape/cost, schedule, task ledger, skill lifecycle tools).
- Deliberate limitation: generic mutation-only tools (`write`, `edit`) are not part of this
  project skill contract; code mutation is delegated to specialized skills such as `patching`.

## Storage Convention

- `skills/base/<skill>/SKILL.md`
- `skills/packs/<pack>/SKILL.md`
- `skills/project/<skill>/SKILL.md`

Runtime discovery also accepts roots provided via `skills.roots` and executable
sidecar assets. See `docs/reference/configuration.md` (Skill Discovery).
