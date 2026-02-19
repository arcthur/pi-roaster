# Reference: Extensions

Extension factory entrypoint: `packages/roaster-extensions/src/index.ts`.

## Factory API

- `createRoasterExtension`
- `roasterExtension`

## Registered Handlers

- `registerEventStream`
- `registerContextTransform`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerCompletionGuard`
- `registerNotification`

## Handler Implementations

- `packages/roaster-extensions/src/event-stream.ts`
- `packages/roaster-extensions/src/context-transform.ts`
- `packages/roaster-extensions/src/quality-gate.ts`
- `packages/roaster-extensions/src/ledger-writer.ts`
- `packages/roaster-extensions/src/completion-guard.ts`
- `packages/roaster-extensions/src/notification.ts`

## Context Transform Notes

- `registerContextTransform` appends a system-level `[Roaster Context Contract]` in `before_agent_start`.
- The contract separates state tape actions (`tape_handoff` / `tape_info` / `tape_search`) from message-buffer compaction (`session_compact`).
- Runtime gate remains fail-closed on critical context pressure when recent compaction is missing.
