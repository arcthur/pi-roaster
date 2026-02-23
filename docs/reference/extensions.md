# Reference: Extensions

Extension factory entrypoint: `packages/brewva-extensions/src/index.ts`.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`

Factory options include:

- `registerTools?: boolean` (defaults to `true`)
- `preferAsyncContextInjection?: boolean` (defaults to `true`; set `false` to force sync `buildContextInjection` even when `buildContextInjectionAsync` exists)

## Registered Handlers

- `registerEventStream`
- `registerContextTransform`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerCompletionGuard`
- `registerNotification`
- `registerMemoryBridge`

## Handler Implementations

- `packages/brewva-extensions/src/event-stream.ts`
- `packages/brewva-extensions/src/context-transform.ts`
- `packages/brewva-extensions/src/quality-gate.ts`
- `packages/brewva-extensions/src/ledger-writer.ts`
- `packages/brewva-extensions/src/completion-guard.ts`
- `packages/brewva-extensions/src/notification.ts`
- `packages/brewva-extensions/src/memory-bridge.ts`

## Context Transform Notes

- `registerContextTransform` appends a system-level `[Brewva Context Contract]` in `before_agent_start`.
- The contract separates state tape actions (`tape_handoff` / `tape_info` / `tape_search`) from message-buffer compaction (`session_compact`).
- Runtime gate remains fail-closed on critical context pressure when recent compaction is missing.
- Context injection prefers async runtime path by default; rollout can force sync path via `preferAsyncContextInjection: false`.
- In the extension-enabled profile, `session_compact` lifecycle bookkeeping is handled in `registerContextTransform`.

## Runtime Core Bridge Notes (`--no-extensions`)

- `createRuntimeCoreBridgeExtension`/`registerRuntimeCoreBridge` provide core safety hooks without the full presentation stack.
- Runtime core bridge handles `before_agent_start` by injecting:
  - a minimal `[Brewva Core Context Contract]` in `systemPrompt`
  - a hidden `[CoreTapeStatus]` status/action block message
- In this profile, `session_compact` and `session_shutdown` lifecycle bookkeeping is handled by runtime core bridge hooks.

## Channel Bridge Notes

- Channel turn bridge helpers (`createRuntimeChannelTurnBridge`,
  `createRuntimeTelegramChannelBridge`) consume channel contracts from
  `@brewva/brewva-runtime/channels` rather than runtime root exports.
