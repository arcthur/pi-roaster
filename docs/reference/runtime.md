# Reference: Runtime API

Primary class: `packages/brewva-runtime/src/runtime.ts`.

## Runtime Role

`BrewvaRuntime` is the public facade for runtime governance. Internally, orchestration is delegated to services under `packages/brewva-runtime/src/services/`, while replay/state folding is handled by `TurnReplayEngine`.

The runtime no longer exposes a large flat method list. Public access is organized into domain APIs.

## Public Surface (Domain APIs)

### `runtime.skills.*`

- `refresh()`
- `getLoadReport()`
- `list()`
- `get(name)`
- `getPendingDispatch(sessionId)`
- `clearPendingDispatch(sessionId)`
- `overridePendingDispatch(sessionId, input?)`
- `reconcilePendingDispatch(sessionId, turn)`
- `activate(sessionId, name)`
- `getActive(sessionId)`
- `validateOutputs(sessionId, outputs)`
- `complete(sessionId, output)`
- `getOutputs(sessionId, skillName)`
- `getConsumedOutputs(sessionId, targetSkillName)`
- `getCascadeIntent(sessionId)`
- `pauseCascade(sessionId, reason?)`
- `resumeCascade(sessionId, reason?)`
- `cancelCascade(sessionId, reason?)`
- `startCascade(sessionId, input)`

### `runtime.proposals.*`

- `submit(sessionId, proposal)`
- `list(sessionId, query?)`

Proposal boundary semantics:

- Deliberation-layer components submit `ProposalEnvelope`.
- Kernel returns `DecisionReceipt` with `accept | reject | defer`.
- `list(sessionId, query?)` returns `ProposalRecord[]` in newest-first order by
  receipt timestamp; `limit: 1` is therefore the latest committed proposal.
- Accepted proposals may arm dispatch gates, create explicit cascade intents, or
  admit replayable context packets.

Reference: `docs/reference/proposal-boundary.md`.

### `runtime.context.*`

- `onUserInput(sessionId)`
- `onTurnStart(sessionId, turnIndex)`
- `onTurnEnd(sessionId)`
- `sanitizeInput(text)`
- `observeUsage(sessionId, usage)`
- `getUsage(sessionId)`
- `getUsageRatio(usage)`
- `getHardLimitRatio()`
- `getCompactionThresholdRatio()`
- `getPressureStatus(sessionId, usage?)`
- `getPressureLevel(sessionId, usage?)`
- `getCompactionGateStatus(sessionId, usage?)`
- `checkCompactionGate(sessionId, toolName, usage?)`
- `buildInjection(sessionId, prompt, usage?, injectionScopeId?)`
- `appendSupplementalInjection(sessionId, inputText, usage?, injectionScopeId?)`
- `checkAndRequestCompaction(sessionId, usage)`
- `requestCompaction(sessionId, reason)`
- `getPendingCompactionReason(sessionId)`
- `getCompactionInstructions()`
- `getCompactionWindowTurns()`
- `markCompacted(sessionId, input)`

### `runtime.tools.*`

- `checkAccess(sessionId, toolName)`
- `explainAccess(input)`
- `start(input)`
- `finish(input)`
  `finish(input)` and `recordResult(input)` use `channelSuccess` for tool/lifecycle transport success; semantic outcome is carried by `verdict`.
- `acquireParallelSlot(sessionId, runId)`
- `releaseParallelSlot(sessionId, runId)`
- `markCall(sessionId, toolName)`
- `trackCallStart(input)`
- `trackCallEnd(input)`
- `rollbackLastPatchSet(sessionId)`
- `resolveUndoSessionId(preferredSessionId?)`
- `recordResult(input)`

### `runtime.task.*`

- `setSpec(sessionId, spec)`
- `addItem(sessionId, input)`
- `updateItem(sessionId, input)`
- `recordBlocker(sessionId, input)`
- `resolveBlocker(sessionId, blockerId)`
- `getState(sessionId)`

### `runtime.truth.*`

- `getState(sessionId)`
- `upsertFact(sessionId, input)`
- `resolveFact(sessionId, truthFactId)`

### `runtime.ledger.*`

- `getDigest(sessionId)`
- `query(sessionId, query)`
- `listRows(sessionId?)`
- `verifyChain(sessionId)`
- `getPath()`

### `runtime.schedule.*`

- `createIntent(sessionId, input)`
- `cancelIntent(sessionId, input)`
- `updateIntent(sessionId, input)`
- `listIntents(query?)`
- `getProjectionSnapshot()`

### `runtime.turnWal.*`

- `appendPending(envelope, source, options?)`
- `markInflight(walId)`
- `markDone(walId)`
- `markFailed(walId, error?)`
- `markExpired(walId)`
- `listPending()`
- `recover()`
- `compact()`

### `runtime.events.*`

- `record(input)`
- `query(sessionId, query?)`
- `queryStructured(sessionId, query?)`
- `getTapeStatus(sessionId)`
- `getTapePressureThresholds()`
- `recordTapeHandoff(sessionId, input)`
- `searchTape(sessionId, input)`
- `listReplaySessions(limit?)`
- `subscribe(listener)`
- `toStructured(event)`
- `list(sessionId, query?)`
- `listSessionIds()`

### `runtime.verification.*`

- `evaluate(sessionId, level?)`
- `verify(sessionId, level?, options?)`

Read-only verification semantics:

- `evaluate(...)` / `verify(...)` return `report.readOnly=true`, `report.skipped=true`,
  `report.reason="read_only"` when no write was observed in session.
- In that case, outcome events are recorded as `outcome="skipped"` (not `pass`).
- Verification failures may be consumed by extension-side controllers such as the
  debug loop, but runtime kernel semantics stay limited to evidence generation
  and replayable event emission.
- The debug loop's persisted `retryCount` is a post-failure retry counter, not a
  total implementation-attempt counter.

### `runtime.cost.*`

- `recordAssistantUsage(input)`
- `getSummary(sessionId)`

### `runtime.session.*`

- `recordWorkerResult(sessionId, result)`
- `listWorkerResults(sessionId)`
- `mergeWorkerResults(sessionId)`
- `clearWorkerResults(sessionId)`
- `clearState(sessionId)`
- `onClearState(listener)`

## Async-Only API Direction

Public runtime integrations should use async-first flows. There is no separate sync facade for context/projection orchestration.

Common async calls:

- `runtime.context.buildInjection(...)`
- `runtime.schedule.createIntent(...)`
- `runtime.schedule.cancelIntent(...)`
- `runtime.schedule.updateIntent(...)`
- `runtime.schedule.listIntents(...)`
- `runtime.schedule.getProjectionSnapshot()`
- `runtime.turnWal.recover()`
- `runtime.verification.verify(...)`

`runtime.context.buildInjection(...)` returns:

- merged `text`
- admitted `entries`
- `accepted`
- token accounting (`originalTokens`, `finalTokens`, `truncated`)

Those entries represent kernel-admitted sources after deterministic budget,
deduplication, and fingerprint checks. Extension profiles may compose those
entries into model-facing blocks, but they do not bypass kernel admission.

## Default Context Injection Semantics

The default injection path is organized around deterministic governance sources:

- `brewva.identity`
- `brewva.truth-static`
- `brewva.truth-facts`
- `brewva.skill-candidates`
- `brewva.skill-dispatch-gate`
- `brewva.skill-cascade-gate`
- `brewva.context-packets`
- `brewva.task-state`
- `brewva.tool-failures`
- `brewva.tool-outputs-distilled`
- `brewva.projection-working`

Truth split behavior:

- `brewva.truth-static` carries the workspace truth-ledger contract block and is
  registered as `oncePerSession`.
- `brewva.truth-facts` carries active truth facts and is refreshed across turns.

Projection split behavior:

- `brewva.projection-working` carries the latest working projection snapshot.
- Projection runtime is working-only: no recall source, no external recall branch.

Context packet behavior:

- accepted `context_packet` proposals inject through `brewva.context-packets`
- packets with `scopeId` inject only when the current injection scope matches
- packets with the same `issuer + scopeId + packetKey` collapse to the latest
  accepted packet
- accepted `revoke` packets suppress the matching packet from future injection
  while keeping tape history intact
- built-in `brewva.extensions.debug-loop` packets are constrained to the
  `status_summary` profile with scoped, TTL-bound injection
- packets stop injecting after `expiresAt`

Model-facing composition behavior:

- runtime admission decides which context entries are allowed
- full extensions may reorder admitted entries into narrative, constraint, and
  diagnostic blocks
- default full-extension behavior is narrative-first
- concise diagnostics are reserved for anomaly cases or explicit diagnostic
  requests

Identity source behavior:

- Source file path: `.brewva/agents/<agent-id>/identity.md` (workspace-relative).
- Agent id resolution order: `BrewvaRuntimeOptions.agentId` -> `BREWVA_AGENT_ID` -> `default`.
- Agent ids are normalized to lowercase slug format (`[a-z0-9._-]`, separators collapsed to `-`).
- Missing or empty identity file means no `brewva.identity` injection.
- Runtime never auto-generates or rewrites identity files.
- `brewva.identity` is registered as `oncePerSession`.
- When `identity.md` uses the headings `Who I Am`, `How I Work`, and
  `What I Care About`, runtime renders a structured `[PersonaProfile]` block
  with those sections.
- When those headings are absent, runtime does not inject a persona profile.

Skill cascade source extension behavior:

- `BrewvaRuntimeOptions.skillCascadeChainSources` allows injecting custom chain
  sources for `dispatch/explicit`.
- Runtime always starts from built-in sources, then overrides by `source` key with
  injected entries (partial injection keeps unspecified built-in sources active).
- Source replacement decisions are policy-governed and emitted in event payloads
  as `sourceDecision` for audit/replay explainability.
- Cascade source arbitration uses `skills.cascade.enabledSources` as allowlist and
  `skills.cascade.sourcePriority` as ordering among enabled sources.
- Continuity-aware selection is now a deliberation concern. The runtime kernel
  only consumes the resulting proposals and does not expose a public routing API.

Context budget behavior:

- Runtime uses a single deterministic injection path:
  global budget cap + hard-limit compaction gate.
- Arena SLO enforcement (`arena.maxEntriesPerSession`) emits `context_arena_slo_enforced`.
- Injection telemetry (`context_injected` / `context_injection_dropped`) records
  deterministic boolean `degradationApplied` state for observability.

Execution profile note:

- Extension-enabled profile (`createBrewvaExtension`) uses full governance lifecycle hooks and projects proposal-derived selection telemetry.
- The full extension profile also owns extension-side closed loops such as automatic
  debug retry and deterministic handoff packet synthesis.
- Runtime-core profile (`--no-addons`) still composes model-facing context
  through `ContextComposer`, applies the standard Brewva context contract,
  persists tool outcomes through `registerLedgerWriter`, distills large
  same-turn pure-text tool results through `registerToolResultDistiller`, and
  keeps `registerCompletionGuard`.
- Runtime-core keeps the reduced lifecycle surface by omitting the `context`
  hook, event streaming, memory handlers, cognitive metrics, notification, and
  debug-loop orchestration.
- Both profiles still participate in the same cognitive-product loops:
  model-facing composition, memory formation, memory rehydration, and
  control-plane wake-up metadata.

## Event Emission Levels

`runtime.events.record(...)` is filtered by `infrastructure.events.level`:

- `audit`: replay/audit critical stream (`anchor`, `checkpoint`, `task_event`, `truth_event`, schedule lifecycle, verification outcomes, tool-result evidence)
- `ops` (default): audit + operational transitions and warnings (including `governance_*`)
- `debug`: full stream, including high-noise diagnostics (for example `tool_parallel_read`)

Switching level changes observability granularity, not business decisions.

## Replay Fold Scope

`TurnReplayEngine` reconstructs state with `checkpoint + delta` from the event tape.
The folded replay view includes:

- task state
- truth state
- cost summary state
- cost skill turn dedupe metadata (`skillLastTurnByName`)
- evidence fold state (including recent tool failures with anchor-epoch TTL pruning)
- projection fold state (`updatedAt`, `unitCount`)

Checkpoint payloads persisted by tape automation include corresponding state slices,
so replay can seek to the latest checkpoint and avoid full-tape recomputation for
these domains.

For projection specifically, the checkpoint slice is observational metadata only
(`updatedAt`, `unitCount`). It is not a semantic working-projection snapshot.
If projection artifacts are missing, runtime rebuilds projection semantics from
source tape events rather than restoring units from checkpoint payload alone.

## Scheduling Notes

- Schedule APIs are intent-based (`createIntent` / `updateIntent` / `cancelIntent`) and persisted through event tape.
- `convergenceCondition` supports structured predicates (including `all_of` / `any_of`) and is evaluated after fired runs.
- Startup recovery is bounded by `schedule.maxRecoveryCatchUps`, with overflow deferral emitted as recovery events.

## Turn WAL Notes

- `runtime.turnWal` manages append-only turn durability rows persisted under `infrastructure.turnWal.dir`.
- Status transitions are event-sourced (`pending` -> `inflight` -> terminal status).
- `recover()` performs startup scan/classification and emits summary telemetry.
- Component-owned replay (channel/gateway/scheduler) should still use source-aware handlers to re-enqueue work.

## Current Limitations

- `runtime.events.query(...)` / `queryStructured(...)` only support lightweight filtering (`type`, `last`), not time-range/offset cursors.
- `runtime.events.subscribe(listener)` is process-local and ephemeral; subscribers do not survive process restart.

## Type Contracts

All shared runtime data contracts are defined in `packages/brewva-runtime/src/types.ts`.

Examples:

- `BrewvaConfig`
- `TaskState`, `TruthState`
- `EvidenceLedgerRow`, `VerificationReport`
- `ScheduleIntent*`
- `TurnWALRecord`, `TurnWALRecoveryResult`
- `BrewvaEventRecord`, `BrewvaStructuredEvent`
