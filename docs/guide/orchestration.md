# Orchestration

Orchestration is driven by runtime state management plus extension lifecycle handlers.

- Runtime state machine: `packages/brewva-runtime/src/runtime.ts`
- Extension registration: `packages/brewva-extensions/src/index.ts`

## Default Profile (Extensions Enabled)

1. CLI creates a session (`packages/brewva-cli/src/session.ts`)
2. Extensions are registered (`packages/brewva-extensions/src/index.ts`)
3. `before_agent_start` runs lifecycle plumbing (`context-transform`) and model-facing composition (`context-composer`)
4. `tool_call` passes quality/security/budget gates (`quality-gate`)
5. `ledger-writer` records durable tool outcomes (normally from SDK `tool_result`; can fallback to `tool_execution_end` when `tool_result` is missing). Persisted governance event is `tool_result_recorded`.
6. `agent_end` records summary events and runs completion guard / notification hooks

## Direct-Tool Profile (`--no-extensions`)

1. CLI registers tools directly (`buildBrewvaTools`)
2. CLI installs `createRuntimeCoreBridgeExtension` (tool surface + memory curator + cognitive metrics + quality gate + ledger writer + reduced lifecycle bridge)
3. `tool_call` passes quality/security/budget gates (`quality-gate`)
4. `ledger-writer` records durable tool outcomes and closes the runtime tool lifecycle (`tool_result_recorded` + `runtime.tools.finish(...)`)
5. CLI installs `registerRuntimeCoreEventBridge` for lifecycle and assistant-usage telemetry
6. Extension-only presentation hooks remain disabled (`context` hook auto-compaction lifecycle,
   completion guard, notification, debug-loop, streaming message-health events)
7. Runtime core bridge still runs `before_agent_start`, but now uses the same
   narrative-first `ContextComposer` and standard Brewva context contract as
   the full profile

## Runtime Subsystems

- Skills: `packages/brewva-runtime/src/skills/registry.ts`
- Verification: `packages/brewva-runtime/src/verification/gate.ts`
- Ledger: `packages/brewva-runtime/src/ledger/evidence-ledger.ts`
- Context budget: `packages/brewva-runtime/src/context/budget.ts`
- Event store: `packages/brewva-runtime/src/events/store.ts`
- Tape replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`
