# Reference: Runtime API

Primary class: `packages/brewva-runtime/src/runtime.ts`.

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
- `buildContextInjection`
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
- `addTaskItem`
- `updateTaskItem`
- `recordTaskBlocker`
- `resolveTaskBlocker`
- `upsertTruthFact`
- `resolveTruthFact`
- `recordEvent`
- `queryEvents`
- `queryStructuredEvents`
- `listReplaySessions`
- `subscribeEvents`
- `toStructuredEvent`
- `recordAssistantUsage`
- `getCostSummary`
- `evaluateCompletion`
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

## Viewport Policy

`buildContextInjection()` may build and inject a viewport context (`brewva.viewport`) to ground the model in a small set of relevant source lines.
When the viewport signal is low (or the context is truncated), the runtime can downshift the viewport variant or skip injecting it entirely.

When policy decisions trigger, the runtime emits `viewport_built` / `viewport_policy_evaluated` events and may inject a `brewva.viewport-policy` guard block to enforce a verification-first posture.
