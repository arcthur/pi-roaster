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

- `browser`
- `bun`
- `frontend-ui-ux`
- `react`
- `typescript`

## Project Skills

- `brewva-project`

## Storage Convention

- `skills/base/<skill>/SKILL.md`
- `skills/packs/<pack>/SKILL.md`
- `skills/project/<skill>/SKILL.md`

Runtime discovery also accepts roots provided via `skills.roots` and executable
sidecar assets. See `docs/reference/configuration.md` (Skill Discovery).
