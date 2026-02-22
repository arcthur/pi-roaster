# Understanding Runtime System

## Runtime Shape

`BrewvaRuntime` in `packages/brewva-runtime/src/runtime.ts` is the public facade and stable API entrypoint.

The facade wires foundational subsystems:

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

Runtime domain logic is delegated to service modules in
`packages/brewva-runtime/src/services/`, including:

- `ContextService`
- `ToolGateService`
- `TaskService`
- `TapeService`
- `VerificationService`
- `FileChangeService`
- `SkillLifecycleService`
- `LedgerService`
- `EventPipelineService`
- `ScheduleIntentService`

`BrewvaRuntime` should remain thin: constructor wiring + one-line method delegation.

## Runtime State Model

Short-lived per-session maps are centralized in
`packages/brewva-runtime/src/services/session-state.ts` (`RuntimeSessionStateStore`).

Task/truth reconstruction is still replay-based (`checkpoint + delta`) through
`TurnReplayEngine`, not persisted in-memory snapshot files.

## Scheduling Boundary

`ScheduleIntentService` lazily creates `SchedulerService` from
`packages/brewva-runtime/src/schedule/service.ts`.

`SchedulerService` depends on `SchedulerRuntimePort` (a narrow runtime adapter),
not on `BrewvaRuntime` directly. This keeps scheduler internals decoupled from
the facade and avoids hidden runtime-to-scheduler coupling.

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
