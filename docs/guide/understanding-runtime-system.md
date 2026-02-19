# Understanding Runtime System

## Core Object

`BrewvaRuntime` in `packages/brewva-runtime/src/runtime.ts` is the central system object.

It composes the following subsystems:

- `skills`
- `ledger`
- `verification`
- `parallel`
- `parallelResults`
- `events`
- `contextBudget`
- `contextInjection`
- `fileChanges`
- `costTracker`

Runtime state reconstruction is handled by tape replay (`checkpoint + delta`) via
`TurnReplayEngine`, not by persisted runtime session-state snapshot files.

## Shared Type Contract

All core contracts are defined in `packages/brewva-runtime/src/types.ts`, including:

- Skill contracts and selection types
- Ledger row and digest types
- Verification evidence and report types
- Event and replay types
- Task/truth/tape state and event payload types
- Patch set and rollback result types
- Parallel slot and worker result types
- Cost tracking types

## Configuration Contract

- Defaults: `packages/brewva-runtime/src/config/defaults.ts`
- Loader: `packages/brewva-runtime/src/config/loader.ts`
- Merge: `packages/brewva-runtime/src/config/merge.ts`

`BrewvaConfig` now includes startup UI policy under `ui`:

- `ui.quietStartup`
- `ui.collapseChangelog`

Runtime remains the canonical source for these values. During session bootstrap,
`@brewva/brewva-cli` reads `runtime.config.ui` and applies it into upstream
`SettingsManager` overrides, so interactive startup output is controlled by
runtime config rather than hardcoded CLI constants.
