# Category And Skills

Skills are loaded by tier with increasing precedence: `base` -> `pack` -> `project`.

## Tier Layout

- Base tier: `skills/base`
- Pack tier: `skills/packs`
- Project tier: `skills/project`

## Active Pack Defaults

Default packs are defined in `packages/roaster-runtime/src/config/defaults.ts`:

- `typescript`
- `react`
- `bun`

Skill configuration contract is defined in `packages/roaster-runtime/src/types.ts` (`RoasterConfig.skills`).

## Contract Tightening

Higher-tier skills cannot relax lower-tier constraints. Merge and tightening logic:

- `packages/roaster-runtime/src/skills/contract.ts`
- `packages/roaster-runtime/src/skills/registry.ts`
