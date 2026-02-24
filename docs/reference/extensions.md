# Reference: Extensions

Extension factory entrypoint: `packages/brewva-extensions/src/index.ts`.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`

Factory options:

- `registerTools?: boolean` (default `true`)

## Registered Handlers

Default extension composition wires:

- `registerEventStream`
- `registerContextTransform`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerCompletionGuard`
- `registerNotification`
- `registerMemoryBridge`

Implementation files:

- `packages/brewva-extensions/src/event-stream.ts`
- `packages/brewva-extensions/src/context-transform.ts`
- `packages/brewva-extensions/src/quality-gate.ts`
- `packages/brewva-extensions/src/ledger-writer.ts`
- `packages/brewva-extensions/src/completion-guard.ts`
- `packages/brewva-extensions/src/notification.ts`
- `packages/brewva-extensions/src/memory-bridge.ts`

## Runtime Integration Contract

Extensions consume runtime domain APIs (for example `runtime.context.*`, `runtime.events.*`, `runtime.tools.*`) instead of legacy flat runtime methods.

Key implications:

- context injection path is async-first (`runtime.context.buildInjection(...)`)
- context pressure/compaction gate checks are delegated to `runtime.context.*`
- event writes/queries/subscriptions are delegated to `runtime.events.*`
- tool policy decisions are delegated to `runtime.tools.*`

## Context Transform Notes

`registerContextTransform` runs on `before_agent_start` and:

- appends a system-level context contract block
- injects runtime-built context via async injection path
- enforces compaction gate behavior under critical context pressure

Default semantic injection sources are:

- `brewva.identity`
- `brewva.truth`
- `brewva.task-state`
- `brewva.tool-failures`
- `brewva.memory`

## Runtime Core Bridge (`--no-extensions`)

`createRuntimeCoreBridgeExtension` / `registerRuntimeCoreBridge` provide minimal safety hooks when full extensions are disabled.

In this profile, core lifecycle bookkeeping (`session_compact`, `session_shutdown`, etc.) is still preserved through runtime bridge hooks.

## Channel Bridge Notes

Channel bridge helpers (`createRuntimeChannelTurnBridge`, `createRuntimeTelegramChannelBridge`) consume channel contracts from `@brewva/brewva-runtime/channels`, not runtime root exports.
