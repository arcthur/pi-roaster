# Category And Skills

Skills are loaded by tier with increasing precedence: `base` -> `pack` -> `project`.

## Tier Layout

- Base tier: `skills/base`
- Pack tier: `skills/packs`
- Project tier: `skills/project`

## Pack Filtering (`skills.packs`)

`skills.packs` (default: `[]`) is an optional allowlist for pack directories across all discovered skill roots.

- empty array: no pack filter, load all discovered packs
- non-empty array: strict allowlist; packs not listed are skipped (reported in `skillLoad.skippedPacks`)

## Current Skill Inventory

- Base: `brainstorming`, `cartography`, `compose`, `debugging`, `execution`, `exploration`, `finishing`, `git`, `patching`, `planning`, `review`, `tdd`, `verification`
- Packs: `agent-browser`, `frontend-design`, `goal-loop`, `gh-issues`, `github`, `skill-creator`, `telegram-channel-behavior`, `telegram-interactive-components`, `zca-structured-output`
- Project: `brewva-project`, `brewva-self-improve`, `brewva-session-logs`

Skill configuration contract is defined in `packages/brewva-runtime/src/types.ts` (`BrewvaConfig.skills`).

## Contract Tightening

Higher-tier skills cannot relax lower-tier constraints. Merge and tightening logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
