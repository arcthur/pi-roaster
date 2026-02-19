# Reference: Extensions

Extension factory entrypoint: `packages/brewva-extensions/src/index.ts`.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`

## Registered Handlers

- `registerEventStream`
- `registerContextTransform`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerCompletionGuard`
- `registerNotification`

## Handler Implementations

- `packages/brewva-extensions/src/event-stream.ts`
- `packages/brewva-extensions/src/context-transform.ts`
- `packages/brewva-extensions/src/quality-gate.ts`
- `packages/brewva-extensions/src/ledger-writer.ts`
- `packages/brewva-extensions/src/completion-guard.ts`
- `packages/brewva-extensions/src/notification.ts`

## Context Transform Notes

- `registerContextTransform` appends a system-level `[Brewva Context Contract]` in `before_agent_start`.
- The contract separates state tape actions (`tape_handoff` / `tape_info` / `tape_search`) from message-buffer compaction (`session_compact`).
- Runtime gate remains fail-closed on critical context pressure when recent compaction is missing.
