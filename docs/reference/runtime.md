# Reference: Runtime API

Primary class: `packages/roaster-runtime/src/runtime.ts`.

## Public Methods

- `refreshSkills`
- `listSkills`
- `getSkill`
- `selectSkills`
- `onTurnStart`
- `observeContextUsage`
- `buildContextInjection`
- `planSupplementalContextInjection`
- `commitSupplementalContextInjection`
- `shouldRequestCompaction`
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
- `getTaskState`
- `addTaskItem`
- `updateTaskItem`
- `recordTaskBlocker`
- `resolveTaskBlocker`
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
- `restoreSessionSnapshot`
- `restoreStartupSession`
- `persistSessionSnapshot`
- `clearSessionSnapshot`
- `sanitizeInput`

## Type Contract

All public runtime data contracts are defined in `packages/roaster-runtime/src/types.ts`.
