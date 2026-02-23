# Reference: Runtime API

Primary class: `packages/brewva-runtime/src/runtime.ts`.

## Runtime Role

- `BrewvaRuntime` is the public facade/API surface.
- Internal orchestration logic is delegated to service modules under
  `packages/brewva-runtime/src/services/`.
- Ephemeral session maps are centralized in `RuntimeSessionStateStore`
  (`packages/brewva-runtime/src/services/session-state.ts`) instead of scattered runtime fields.

## Import Boundaries

- Runtime core contracts and facade APIs are imported from `@brewva/brewva-runtime`.
- Channel adapter/turn contracts are imported from `@brewva/brewva-runtime/channels`.
- The root runtime entry intentionally excludes channel exports to keep runtime API
  surface focused on core orchestration concerns.

## Public Methods

- `refreshSkills`
- `listSkills`
- `getSkill`
- `selectSkills`
- `onTurnStart`
- `observeContextUsage`
- `getContextUsage`
- `getContextUsageRatio`
- `getContextHardLimitRatio`
- `getContextCompactionThresholdRatio`
- `getContextPressureStatus`
- `getContextPressureLevel`
- `getContextCompactionGateStatus`
- `buildContextInjection`
- `buildContextInjectionAsync`
- `planSupplementalContextInjection`
- `commitSupplementalContextInjection`
- `shouldRequestCompaction`
- `getCompactionInstructions`
- `markContextCompacted`
- `activateSkill`
- `getActiveSkill`
- `validateSkillOutputs`
- `completeSkill`
- `getSkillOutputs`
- `getAvailableConsumedOutputs`
- `validateComposePlan`
- `checkToolAccess`
- `checkContextCompactionGate`
- `startToolCall`
- `finishToolCall`
- `markToolCall`
- `trackToolCallStart`
- `trackToolCallEnd`
- `rollbackLastPatchSet`
- `resolveUndoSessionId`
- `recordToolResult`
- `getLedgerDigest`
- `queryLedger`
- `setTaskSpec`
- `recordTapeHandoff`
- `getTapeStatus`
- `searchTape`
- `getTaskState`
- `getTruthState`
- `getWorkingMemory`
- `searchMemory`
- `searchMemoryAsync`
- `dismissMemoryInsight`
- `reviewMemoryEvolvesEdge`
- `addTaskItem`
- `updateTaskItem`
- `recordTaskBlocker`
- `resolveTaskBlocker`
- `upsertTruthFact`
- `resolveTruthFact`
- `createScheduleIntent`
- `cancelScheduleIntent`
- `updateScheduleIntent`
- `listScheduleIntents`
- `getScheduleProjectionSnapshot`
- `recordEvent`
- `queryEvents`
- `queryStructuredEvents`
- `listReplaySessions`
- `subscribeEvents`
- `toStructuredEvent`
- `recordAssistantUsage`
- `getCostSummary`
- `evaluateCompletion`
- `verifyCompletion`
- `acquireParallelSlot`
- `releaseParallelSlot`
- `recordWorkerResult`
- `listWorkerResults`
- `mergeWorkerResults`
- `clearWorkerResults`
- `clearSessionState`
- `sanitizeInput`

## Type Contract

All public runtime data contracts are defined in `packages/brewva-runtime/src/types.ts`.

## Memory Search Contract

- `searchMemory()` returns a versioned payload with:
  - `schema: "brewva.memory.search.v1"`
  - `version: 1`
  - `rankingModel` weights (`lexicalWeight`, `recencyWeight`, `confidenceWeight`)
- Each hit includes query-time ranking signals:
  - `sourceTier`: `"session"` | `"global"`
  - `ranking.schema: "brewva.memory.ranking.v1"`
  - `ranking.lexical`, `ranking.recency`, `ranking.confidence`
  - weighted contributions (`weightedLexical`, `weightedRecency`, `weightedConfidence`)
  - `rank` and `weakSemantic`
- Learning/global knowledge hits expose protocol-agnostic facets:
  - `knowledgeFacets.pattern`, `knowledgeFacets.patterns`
  - `knowledgeFacets.rootCause`, `knowledgeFacets.rootCauses`
  - `knowledgeFacets.recommendation`, `knowledgeFacets.recommendations`
  - `knowledgeFacets.lessonKey`, `knowledgeFacets.lessonKeys`
  - `knowledgeFacets.outcomes`, `knowledgeFacets.sourceSessionIds`, `knowledgeFacets.sourceSessionCount`, `knowledgeFacets.unitCount`
- Global learning-unit hits may include:
  - `lessonProtocol.schema: "brewva.memory.global-lesson.v1"`
  - normalized structured lesson fields (`lessonKey`, `pattern`, `patterns`, `rootCause`, `rootCauses`, `recommendation`, `recommendations`, `outcomes`, `sourceSessionIds`)
- Global crystal hits expose a structured protocol payload:
  - `crystalProtocol.schema: "brewva.memory.global-crystal.v1"`
  - `crystalProtocol.version`
  - normalized fields (`pattern`, `patterns`, `rootCause`, `rootCauses`, `recommendation`, `recommendations`, `lessonKeys`, `outcomes`, `sourceSessionIds`, `unitCount`)
- Cognitive ranking notes:
  - `searchMemory()` is synchronous. If `cognitive.rankRelevance` resolves asynchronously, ranking is recorded for audit but not applied to the returned hit order.
  - In that case runtime emits `cognitive_relevance_ranking_skipped` with `reason=async_result_not_applicable_to_sync_search`.
  - `searchMemoryAsync()` awaits async `cognitive.rankRelevance` results and applies re-ranking in `memory.cognitive.mode="active"`.
  - `buildContextInjection()` uses synchronous memory recall and therefore cannot apply async `cognitive.rankRelevance` reordering.
  - `buildContextInjectionAsync()` awaits async recall and can apply async `cognitive.rankRelevance` reordering.
- Recall block rendering notes:
  - `buildRecallBlock()` / `buildRecallBlockAsync()` append a `facets:` line when a hit carries `knowledgeFacets` signal (`pattern/root_cause/recommendation/outcomes`).

## Scheduling Notes

- `createScheduleIntent()` accepts either `runAt` (one-shot) or `cron` (recurring).
- `runAt` and `cron` are mutually exclusive.
- `createScheduleIntent()` accepts `timeZone` for `cron` intents; omitted timezone
  is persisted as the local host timezone.
- One-shot `runAt` is clamped by `schedule.minIntervalMs` to avoid immediate fire storms.
- Active intent quota is enforced by both `schedule.maxActiveIntentsPerSession` and
  `schedule.maxActiveIntentsGlobal`.
- `updateScheduleIntent()` allows schedule-target changes (`runAt` / `cron` / `timeZone`)
  plus semantic updates (`reason`, `goalRef`, `continuityMode`, `maxRuns`,
  `convergenceCondition`).
- `convergenceCondition` uses structured predicates (`truth_resolved`, `task_phase`,
  `max_runs`, `all_of`, `any_of`) and is evaluated after each fired run.
- `SchedulerService.recover()` returns catch-up telemetry (`dueIntents`,
  `firedIntents`, `deferredIntents`) plus per-session summaries
  (`catchUp.sessions`).
- If missed intents exceed `schedule.maxRecoveryCatchUps`, overflow intents are
  deferred via `intent_updated` projection writes and
  `schedule_recovery_deferred` events.
- Recovery emits `schedule_recovery_summary` events per affected parent session.
- Recovery catch-up uses session round-robin selection before deferring overflow
  intents, improving fairness across parent sessions under backlog pressure.
- Fire-time failures apply exponential backoff based on `schedule.minIntervalMs`
  and open a circuit after `schedule.maxConsecutiveErrors` (intent transitions to
  `error` via `intent_cancelled` with `error` payload).
- Schedule APIs persist through `recordEvent()`. If event storage is disabled,
  schedule mutations return `events_store_disabled`.
- Scheduler internals depend on `SchedulerRuntimePort` (a narrow adapter in
  `schedule/service.ts`) rather than the full `BrewvaRuntime` object.

## Viewport Policy

`buildContextInjection()` may build and inject a viewport context (`brewva.viewport`) to ground the model in a small set of relevant source lines.
When the viewport signal is low (or the context is truncated), the runtime can downshift the viewport variant or skip injecting it entirely.

When policy decisions trigger, the runtime emits `viewport_built` / `viewport_policy_evaluated` events and may inject a `brewva.viewport-policy` guard block to enforce a verification-first posture.
