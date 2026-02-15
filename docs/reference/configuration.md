# Reference: Configuration

Configuration contract sources:

- Default values: `packages/roaster-runtime/src/config/defaults.ts`
- Loader entrypoint: `packages/roaster-runtime/src/config/loader.ts`
- Type contract: `packages/roaster-runtime/src/types.ts`

## Top-Level Keys

`RoasterConfig` supports the following top-level keys:

- `skills`
- `verification`
- `ledger`
- `security`
- `parallel`
- `infrastructure`

## Key Defaults

- `skills.packs`: `typescript`, `react`, `bun`
- `verification.defaultLevel`: `standard`
- `ledger.path`: `.orchestrator/ledger/evidence.jsonl`
- `parallel.maxConcurrent`: `3`
- `parallel.maxTotal`: `10`
- `infrastructure.events.dir`: `.orchestrator/events`
- `infrastructure.contextBudget.truncationStrategy`: `summarize`
- `infrastructure.contextBudget.minSecondsBetweenCompaction`: `45`
- `infrastructure.contextBudget.pressureBypassPercent`: `0.94`
- `infrastructure.contextBudget.compactionCircuitBreaker.maxConsecutiveFailures`: `2`
- `infrastructure.contextBudget.compactionCircuitBreaker.cooldownTurns`: `2`
- `infrastructure.interruptRecovery.snapshotsDir`: `.orchestrator/state`
- `infrastructure.interruptRecovery.resumeHintInjectionEnabled`: `true`
- `infrastructure.interruptRecovery.sessionHandoff.enabled`: `true`
- `infrastructure.interruptRecovery.sessionHandoff.maxSummaryChars`: `800`
- `infrastructure.interruptRecovery.sessionHandoff.relevance.enabled`: `true`
- `infrastructure.interruptRecovery.sessionHandoff.relevance.goalWeight`: `1.4`
- `infrastructure.interruptRecovery.sessionHandoff.relevance.failureWeight`: `1.2`
- `infrastructure.interruptRecovery.sessionHandoff.relevance.recencyWeight`: `0.8`
- `infrastructure.interruptRecovery.sessionHandoff.relevance.artifactWeight`: `0.6`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.enabled`: `true`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.branchFactor`: `3`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.maxLevels`: `3`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.entriesPerLevel`: `3`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.maxCharsPerEntry`: `240`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.goalFilterEnabled`: `true`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.minGoalScore`: `0.34`
- `infrastructure.interruptRecovery.sessionHandoff.hierarchy.maxInjectedEntries`: `4`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.enabled`: `true`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxTotalChars`: `1600`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxUserPreferencesChars`: `220`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxUserHandoffChars`: `420`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxHierarchyChars`: `640`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxUserDigestChars`: `260`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxSessionHandoffChars`: `520`
- `infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxSessionDigestChars`: `320`
- `infrastructure.interruptRecovery.sessionHandoff.circuitBreaker.maxConsecutiveFailures`: `2`
- `infrastructure.interruptRecovery.sessionHandoff.circuitBreaker.cooldownTurns`: `2`

`infrastructure.interruptRecovery.resumeHintInSystemPrompt` remains supported as a backward-compatible alias.  
If both keys are set, `resumeHintInjectionEnabled` takes precedence; if only the legacy key is set, its value is mapped automatically.

## Context Budget Behavior

- `infrastructure.contextBudget.enabled=false` disables runtime context-budget enforcement for:
  - primary context injection token caps
  - supplemental context injection token caps
  - compaction threshold / hard-limit decisions
- `maxInjectionTokens` and related thresholds apply only when `enabled=true`.

## Config File Location

Default config path: `.pi/roaster.json`.

Loading behavior is implemented in `packages/roaster-runtime/src/config/loader.ts`.

## JSON Schema

To enable editor completion and validation for `.pi/roaster.json`, set `$schema` to the schema file shipped with the runtime package:

```json
{
  "$schema": "../node_modules/@pi-roaster/roaster-runtime/schema/roaster.schema.json"
}
```

If you store the config file elsewhere (for example via `--config`), adjust the relative path accordingly.

## Security

- `security.sanitizeContext`: Enables basic sanitization/redaction for user-provided text before it is used for skill selection and context injection (default `true`).
- `security.enforceDeniedTools`: When enabled, tools listed in a skill contract `tools.denied` are blocked (default `true`).
- `security.allowedToolsMode`: `off` | `warn` | `enforce` (default `warn`).
  - `off`: Do not apply allowlist checks. Only denied tools can block (controlled by `enforceDeniedTools`).
  - `warn`: Allow disallowed tools, but emit a `tool_contract_warning` event the first time a (session, skill, tool) violation occurs.
    If a skill's allowlist is empty, allowlist checks are skipped to avoid accidental total blocking.
  - `enforce`: Block tools that are not declared in `tools.required` or `tools.optional` (with a small set of always-allowed lifecycle tools to avoid deadlocks).
    If a skill's allowlist is empty, allowlist checks are skipped to avoid accidental total blocking.
- `security.skillMaxTokensMode`: `off` | `warn` | `enforce` (default `warn`).
  - `off`: Do not apply the per-skill `budget.maxTokens` contract at runtime.
  - `warn`: Once a skill reaches/exceeds `maxTokens`, allow tool calls but emit a `skill_budget_warning` event once per (session, skill).
  - `enforce`: Once a skill reaches/exceeds `maxTokens`, block tool calls (except always-allowed lifecycle tools).
- `security.skillMaxParallelMode`: `off` | `warn` | `enforce` (default `warn`).
  - `off`: Do not apply the per-skill `maxParallel` contract; only the global `parallel.*` limits apply.
  - `warn`: When a skill reaches/exceeds `maxParallel` active runs, allow acquisitions but emit a `skill_parallel_warning` event once per (session, skill).
  - `enforce`: Reject `RoasterRuntime.acquireParallelSlot()` calls once `maxParallel` is reached, returning `reason=skill_max_parallel`.
