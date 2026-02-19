# Category And Skills

Skills are loaded by tier with increasing precedence: `base` -> `pack` -> `project`.

## Tier Layout

- Base tier: `skills/base`
- Pack tier: `skills/packs`
- Project tier: `skills/project`

## Active Pack Defaults

Default packs are defined in `packages/brewva-runtime/src/config/defaults.ts`:

- `typescript`
- `react`
- `bun`

Skill configuration contract is defined in `packages/brewva-runtime/src/types.ts` (`BrewvaConfig.skills`).

## Contract Tightening

Higher-tier skills cannot relax lower-tier constraints. Merge and tightening logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
