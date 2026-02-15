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
- `registerMemory`
- `registerCompletionGuard`
- `registerNotification`

## Handler Implementations

- `packages/roaster-extensions/src/event-stream.ts`
- `packages/roaster-extensions/src/context-transform.ts`
- `packages/roaster-extensions/src/quality-gate.ts`
- `packages/roaster-extensions/src/ledger-writer.ts`
- `packages/roaster-extensions/src/memory.ts`
- `packages/roaster-extensions/src/completion-guard.ts`
- `packages/roaster-extensions/src/notification.ts`
