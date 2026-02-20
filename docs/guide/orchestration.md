# Orchestration

Orchestration is driven by runtime state management plus extension lifecycle handlers.

- Runtime state machine: `packages/brewva-runtime/src/runtime.ts`
- Extension registration: `packages/brewva-extensions/src/index.ts`

## Default Profile (Extensions Enabled)

1. CLI creates a session (`packages/brewva-cli/src/session.ts`)
2. Extensions are registered (`packages/brewva-extensions/src/index.ts`)
3. `before_agent_start` injects context contract + tape status + replay context (`context-transform`)
4. `tool_call` passes quality/security/budget gates (`quality-gate`)
5. SDK `tool_result` hook updates ledger/truth/verification and tool-call tracking (`ledger-writer`); persisted semantic event is `tool_result_recorded`
6. `agent_end` records summary events and runs completion guard / notification hooks

## Direct-Tool Profile (`--no-extensions`)

1. CLI registers tools directly (`buildBrewvaTools`)
2. CLI installs `createRuntimeCoreBridgeExtension` (quality gate + ledger writer + compact lifecycle bridge)
3. Runtime core bridge enforces `startToolCall`/`finishToolCall` semantics:
   tool policy + critical compaction gate + tool-call accounting + patch tracking + ledger write
4. CLI installs `registerRuntimeCoreEventBridge` for lifecycle and assistant-usage telemetry
5. Extension-only presentation hooks remain disabled (`before_agent_start` context injection,
   completion guard, notification, streaming message-health events)

## Runtime Subsystems

- Skills: `packages/brewva-runtime/src/skills/registry.ts`
- Verification: `packages/brewva-runtime/src/verification/gate.ts`
- Ledger: `packages/brewva-runtime/src/ledger/evidence-ledger.ts`
- Context budget: `packages/brewva-runtime/src/context/budget.ts`
- Event store: `packages/brewva-runtime/src/events/store.ts`
- Tape replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`
