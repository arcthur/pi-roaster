# Orchestration

Orchestration is driven by runtime state management plus extension lifecycle handlers.

- Runtime state machine: `packages/brewva-runtime/src/runtime.ts`
- Extension registration: `packages/brewva-extensions/src/index.ts`

## Default Profile (Extensions Enabled)

1. CLI creates a session (`packages/brewva-cli/src/session.ts`)
2. Extensions are registered (`packages/brewva-extensions/src/index.ts`)
3. `before_agent_start` injects context contract + tape status + replay context (`context-transform`)
4. `tool_call` passes quality/security/budget gates (`quality-gate`)
5. `tool_result` updates ledger, truth/verification evidence, and tool-call tracking (`ledger-writer`)
6. `agent_end` records summary events and runs completion guard / notification hooks

## Direct-Tool Profile (`--no-extensions`)

1. CLI registers runtime-aware tools directly (`buildBrewvaTools`)
2. CLI installs `registerRuntimeCoreEventBridge` for core lifecycle/cost telemetry
3. Session can execute tools and runtime APIs without extension hook chain

This profile is intentionally reduced: extension-layer context transform and
guard behaviors are not active.

## Runtime Subsystems

- Skills: `packages/brewva-runtime/src/skills/registry.ts`
- Verification: `packages/brewva-runtime/src/verification/gate.ts`
- Ledger: `packages/brewva-runtime/src/ledger/evidence-ledger.ts`
- Context budget: `packages/brewva-runtime/src/context/budget.ts`
- Event store: `packages/brewva-runtime/src/events/store.ts`
- Tape replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`
