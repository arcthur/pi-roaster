# Reference: Runtime API

Primary class: `packages/brewva-runtime/src/runtime.ts`.

## Runtime Role

`BrewvaRuntime` is the public facade for runtime governance. Internally, orchestration is delegated to services under `packages/brewva-runtime/src/services/`, while replay/state folding is handled by `TurnReplayEngine`.

The runtime no longer exposes a large flat method list. Public access is organized into domain APIs.

## Public Surface (Domain APIs)

### `runtime.skills.*`

- `refresh()`
- `list()`
- `get(name)`
- `select(message)`
- `prepareDispatch(sessionId, message)`
- `getPendingDispatch(sessionId)`
- `clearPendingDispatch(sessionId)`
- `overridePendingDispatch(sessionId, input?)`
- `reconcilePendingDispatch(sessionId, turn)`
- `activate(sessionId, name)`
- `getActive(sessionId)`
- `validateOutputs(sessionId, outputs)`
- `validateComposePlan(plan)`
- `complete(sessionId, output)`
- `getOutputs(sessionId, skillName)`
- `getConsumedOutputs(sessionId, targetSkillName)`
- `setNextSelection(sessionId, selected, input?)`
- `clearNextSelection(sessionId)`
- `getCascadeIntent(sessionId)`
- `pauseCascade(sessionId, reason?)`
- `resumeCascade(sessionId, reason?)`
- `cancelCascade(sessionId, reason?)`
- `startCascade(sessionId, input)`

### `runtime.context.*`

- `onTurnStart(sessionId, turnIndex)`
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
- `start(input)`
- `finish(input)`
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
- `getLedgerDigest(sessionId)`
- `queryLedger(sessionId, query)`
- `listLedgerRows(sessionId?)`
- `verifyLedgerChain(sessionId)`
- `getLedgerPath()`
- `upsertFact(sessionId, input)`
- `resolveFact(sessionId, truthFactId)`

### `runtime.memory.*`

- `getWorking(sessionId)`
- `search(sessionId, input)`
- `dismissInsight(sessionId, insightId)`
- `reviewEvolvesEdge(sessionId, input)`
- `refreshIfNeeded(input)`
- `clearSessionCache(sessionId)`

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

### `runtime.cost.*`

- `recordAssistantUsage(input)`
- `getSummary(sessionId)`

### `runtime.session.*`

- `recordWorkerResult(sessionId, result)`
- `listWorkerResults(sessionId)`
- `mergeWorkerResults(sessionId)`
- `clearWorkerResults(sessionId)`
- `clearState(sessionId)`

## Async-Only API Direction

Public runtime integrations should use async-first flows. There is no separate sync facade for context/memory orchestration.

Common async calls:

- `runtime.context.buildInjection(...)`
- `runtime.memory.search(...)`
- `runtime.schedule.createIntent(...)`
- `runtime.schedule.cancelIntent(...)`
- `runtime.schedule.updateIntent(...)`
- `runtime.schedule.listIntents(...)`
- `runtime.schedule.getProjectionSnapshot()`
- `runtime.turnWal.recover()`
- `runtime.verification.verify(...)`

## Default Context Injection Semantics

The default injection path is organized around eleven semantic sources (the
eleventh is optional and budget-gated):

- `brewva.identity`
- `brewva.truth-static`
- `brewva.truth-facts`
- `brewva.skill-candidates`
- `brewva.skill-dispatch-gate`
- `brewva.task-state`
- `brewva.tool-failures`
- `brewva.tool-outputs-distilled`
- `brewva.memory-working`
- `brewva.memory-recall`
- `brewva.rag-external`

Truth split behavior:

- `brewva.truth-static` carries the workspace truth-ledger contract block and is
  registered as `oncePerSession`.
- `brewva.truth-facts` carries active truth facts and is refreshed across turns.

Memory split behavior:

- `brewva.memory-working` carries the latest working-memory snapshot and is
  registered as `critical`.
- `brewva.memory-recall` carries retrieval hits and is registered as `normal`.
- `memory.recallMode="always"` always enables recall.
- `memory.recallMode="pressure-aware"` skips recall under `high`/`critical` context pressure.
- Under `memory.recallMode="pressure-aware"`, external recall is also skipped when pressure is
  `high`/`critical` (`context_external_recall_decision` with `reason="pressure_gated"`).
- Open memory insights can expand recall query terms (`memory_recall_query_expanded` event).
- `brewva.rag-external` is injected only when `memory.externalRecall.enabled=true`,
  active skill carries tag `external-knowledge`, internal recall top score is below
  threshold (`memory.externalRecall.minInternalScore`).
- If `BrewvaRuntimeOptions.externalRecallPort` is not provided, external recall is skipped
  (`context_external_recall_decision` with `outcome="skipped"` and
  `reason="provider_unavailable"`).

Identity source behavior:

- Source file path: `.brewva/agents/<agent-id>/identity.md` (workspace-relative).
- Agent id resolution order: `BrewvaRuntimeOptions.agentId` -> `BREWVA_AGENT_ID` -> `default`.
- Agent ids are normalized to lowercase slug format (`[a-z0-9._-]`, separators collapsed to `-`).
- Missing or empty identity file means no `brewva.identity` injection.
- Runtime never auto-generates or rewrites identity files.
- `brewva.identity` is registered as `critical` + `oncePerSession`.

Skill cascade source extension behavior:

- `BrewvaRuntimeOptions.skillCascadeChainSources` allows injecting custom chain
  sources for `dispatch/compose/explicit`.
- Runtime always starts from built-in sources, then overrides by `source` key with
  injected entries (partial injection keeps unspecified built-in sources active).
- Source replacement decisions are policy-governed and emitted in event payloads
  as `sourceDecision` for audit/replay explainability.
- Cascade source arbitration uses `skills.cascade.enabledSources` as allowlist and
  `skills.cascade.sourcePriority` as ordering among enabled sources.

Context budget behavior:

- Runtime uses a single deterministic injection path:
  global budget cap + hard-limit compaction gate.
- Arena SLO enforcement (`arena.maxEntriesPerSession`,
  deterministic `drop_recall` policy) emits `context_arena_slo_enforced`.
- Injection telemetry (`context_injected` / `context_injection_dropped`) records
  deterministic boolean `degradationApplied` state for observability.

Execution profile note:

- Extension-enabled profile (`createBrewvaExtension`) uses full semantic injections.
- Runtime-core profile (`--no-extensions`) injects only `[CoreTapeStatus]` + core autonomy contract.

## Event Emission Levels

`runtime.events.record(...)` is filtered by `infrastructure.events.level`:

- `audit`: replay/audit critical stream (`anchor`, `checkpoint`, `task_event`, `truth_event`, schedule lifecycle, verification outcomes, tool-result evidence)
- `ops` (default): audit + operational transitions and warnings
- `debug`: full stream, including high-noise diagnostics (`cognitive_*`, parallel scan detail)
- Exception: `cognitive_relevance_ranking*` events are kept at `ops` for ranking observability.

Switching level changes observability granularity, not business decisions.

## Replay Fold Scope

`TurnReplayEngine` reconstructs state with `checkpoint + delta` from the event tape.
The folded replay view includes:

- task state
- truth state
- cost summary state
- cost skill turn dedupe metadata (`skillLastTurnByName`)
- evidence fold state (including recent tool failures with anchor-epoch TTL pruning)
- memory crystal fold state

Checkpoint payloads persisted by tape automation include corresponding state slices,
so replay can seek to the latest checkpoint and avoid full-tape recomputation for
these domains.

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
- `ScheduleIntent*`
- `TurnWALRecord`, `TurnWALRecoveryResult`
- `BrewvaEventRecord`, `BrewvaStructuredEvent`
- `MemorySearchResult`
