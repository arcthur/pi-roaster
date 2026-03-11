# Orchestration

Orchestration is driven by runtime state management plus extension lifecycle handlers.

- Runtime state machine: `packages/brewva-runtime/src/runtime.ts`
- Extension registration: `packages/brewva-gateway/src/runtime-plugins/index.ts`

## Default Profile (Extensions Enabled)

1. Gateway host creates a session (`packages/brewva-gateway/src/host/create-hosted-session.ts`)
2. Extensions are registered (`packages/brewva-gateway/src/runtime-plugins/index.ts`)
3. `before_agent_start` runs lifecycle plumbing (`context-transform`) and model-facing composition (`context-composer`)
4. `tool_call` passes quality/security/budget gates (`quality-gate`)
5. `ledger-writer` records durable tool outcomes (normally from SDK `tool_result`; can fallback to `tool_execution_end` when `tool_result` is missing). Persisted governance event is `tool_result_recorded`.
6. `tool-result-distiller` may replace large pure-text `tool_result` payloads with bounded same-turn summaries after raw evidence is recorded.
7. `agent_end` records summary events and runs completion guard / notification hooks

## Direct-Tool Profile (`--no-addons`)

1. Gateway host registers tools directly (`buildBrewvaTools`)
2. Gateway host installs `createRuntimeCoreBridgeExtension` (tool surface + quality gate + ledger writer + tool-result distiller + completion guard + reduced lifecycle bridge)
3. `tool_call` passes quality/security/budget gates (`quality-gate`)
4. `ledger-writer` records durable tool outcomes and closes the runtime tool lifecycle (`tool_result_recorded` + `runtime.tools.finish(...)`)
5. `tool-result-distiller` may replace large pure-text `tool_result` payloads with bounded same-turn summaries after raw evidence is recorded.
6. Gateway host installs `registerRuntimeCoreEventBridge` for lifecycle and assistant-usage telemetry
7. Extension-only presentation hooks remain disabled (`context` hook auto-compaction lifecycle,
   event streaming, memory handlers, cognitive metrics, notification, debug-loop, streaming message-health events)
8. Runtime core bridge still runs `before_agent_start`, but now uses the same
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
