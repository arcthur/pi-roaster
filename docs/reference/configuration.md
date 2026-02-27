# Reference: Configuration

Configuration contract sources:

- Defaults: `packages/brewva-runtime/src/config/defaults.ts`
- Loader: `packages/brewva-runtime/src/config/loader.ts`
- Normalizer: `packages/brewva-runtime/src/config/normalize.ts`
- Type contract: `packages/brewva-runtime/src/types.ts`
- Schema: `packages/brewva-runtime/schema/brewva.schema.json`

## Top-Level Keys

`BrewvaConfig` supports:

- `skills`
- `verification`
- `ledger`
- `tape`
- `memory`
- `security`
- `schedule`
- `parallel`
- `channels`
- `infrastructure`
- `ui`

Configuration files are patch overlays: omitted fields inherit defaults/lower-precedence layers.

## Key Defaults

### `skills`

- `skills.roots`: `[]`
- `skills.packs`: `["skill-creator", "telegram-interactive-components"]`
- `skills.disabled`: `[]`
- `skills.overrides`: `{}`
- `skills.selector.k`: `4`

### `verification`

- `verification.defaultLevel`: `standard`
- `verification.checks.quick`: `["type-check"]`
- `verification.checks.standard`: `["type-check", "tests", "lint"]`
- `verification.checks.strict`: `["type-check", "tests", "lint", "diff-review"]`
- `verification.commands.type-check`: `bun run typecheck`
- `verification.commands.tests`: `bun test`
- `verification.commands.lint`: `bunx tsc --noEmit`
- `verification.commands.diff-review`: `git diff --stat`

### `ledger`

- `ledger.path`: `.orchestrator/ledger/evidence.jsonl`
- `ledger.checkpointEveryTurns`: `20`

### `tape`

- `tape.checkpointIntervalEntries`: `120`

### `memory`

- `memory.enabled`: `true`
- `memory.dir`: `.orchestrator/memory`
- `memory.workingFile`: `working.md`
- `memory.maxWorkingChars`: `2400`
- `memory.dailyRefreshHourLocal`: `8`
- `memory.crystalMinUnits`: `4`
- `memory.retrievalTopK`: `8`
- `memory.retrievalWeights.lexical`: `0.55`
- `memory.retrievalWeights.recency`: `0.25`
- `memory.retrievalWeights.confidence`: `0.20`
- `memory.recallMode`: `primary`
- `memory.externalRecall.enabled`: `false`
- `memory.externalRecall.minInternalScore`: `0.62`
- `memory.externalRecall.queryTopK`: `5`
- `memory.externalRecall.injectedConfidence`: `0.6`
- `memory.evolvesMode`: `shadow`
- `memory.cognitive.mode`: `active`
- `memory.cognitive.maxTokensPerTurn`: `0` (`0` means unlimited)
- `memory.global.enabled`: `true`
- `memory.global.minConfidence`: `0.8`

### `security`

- `security.mode`: `standard`
- `security.sanitizeContext`: `true`
- `security.execution.backend`: `auto`
- `security.execution.enforceIsolation`: `false`
- `security.execution.fallbackToHost`: `true`
- `security.execution.commandDenyList`: `[]`
- `security.execution.sandbox.serverUrl`: `http://127.0.0.1:5555`
- `security.execution.sandbox.defaultImage`: `microsandbox/node`
- `security.execution.sandbox.memory`: `512`
- `security.execution.sandbox.cpus`: `1`
- `security.execution.sandbox.timeout`: `180`

### `schedule`

- `schedule.enabled`: `true`
- `schedule.projectionPath`: `.brewva/schedule/intents.jsonl`
- `schedule.leaseDurationMs`: `60000`
- `schedule.maxActiveIntentsPerSession`: `5`
- `schedule.maxActiveIntentsGlobal`: `20`
- `schedule.minIntervalMs`: `60000`
- `schedule.maxConsecutiveErrors`: `3`
- `schedule.maxRecoveryCatchUps`: `5`

### `parallel`

- `parallel.enabled`: `true`
- `parallel.maxConcurrent`: `3`

### `channels`

- `channels.orchestration.enabled`: `true`
- `channels.orchestration.scopeStrategy`: `chat`
- `channels.orchestration.aclModeWhenOwnersEmpty`: `open`
- `channels.orchestration.owners.telegram`: `[]`
- `channels.orchestration.limits.fanoutMaxAgents`: `4`
- `channels.orchestration.limits.maxDiscussionRounds`: `3`
- `channels.orchestration.limits.a2aMaxDepth`: `4`
- `channels.orchestration.limits.a2aMaxHops`: `6`
- `channels.orchestration.limits.maxLiveRuntimes`: `8`
- `channels.orchestration.limits.idleRuntimeTtlMs`: `900000`

### `infrastructure`

- `infrastructure.events.enabled`: `true`
- `infrastructure.events.dir`: `.orchestrator/events`
- `infrastructure.events.level`: `ops`
- `infrastructure.contextBudget.enabled`: `true`
- `infrastructure.contextBudget.maxInjectionTokens`: `1200`
- `infrastructure.contextBudget.compactionThresholdPercent`: `0.82`
- `infrastructure.contextBudget.hardLimitPercent`: `0.94`
- `infrastructure.contextBudget.truncationStrategy`: `summarize`
- `infrastructure.contextBudget.compactionInstructions`: default operational compaction guidance string
- `infrastructure.contextBudget.compaction.minTurnsBetween`: `2`
- `infrastructure.contextBudget.compaction.minSecondsBetween`: `45`
- `infrastructure.contextBudget.compaction.pressureBypassPercent`: `0.94`
- `infrastructure.contextBudget.adaptiveZones.enabled`: `true`
- `infrastructure.contextBudget.adaptiveZones.emaAlpha`: `0.3`
- `infrastructure.contextBudget.adaptiveZones.minTurnsBeforeAdapt`: `3`
- `infrastructure.contextBudget.adaptiveZones.stepTokens`: `32`
- `infrastructure.contextBudget.adaptiveZones.maxShiftPerTurn`: `96`
- `infrastructure.contextBudget.adaptiveZones.upshiftTruncationRatio`: `0.25`
- `infrastructure.contextBudget.adaptiveZones.downshiftIdleRatio`: `0.15`
- `infrastructure.contextBudget.floorUnmetPolicy.enabled`: `true`
- `infrastructure.contextBudget.floorUnmetPolicy.relaxOrder`: `["memory_recall", "tool_failures", "memory_working"]`
- `infrastructure.contextBudget.floorUnmetPolicy.finalFallback`: `critical_only`
- `infrastructure.contextBudget.floorUnmetPolicy.requestCompaction`: `true`
- `infrastructure.contextBudget.arena.maxEntriesPerSession`: `4096`
- `infrastructure.contextBudget.arena.degradationPolicy`: `drop_recall`
- `infrastructure.contextBudget.arena.zones.identity`: `{ min: 0, max: 320 }`
- `infrastructure.contextBudget.arena.zones.truth`: `{ min: 0, max: 420 }`
- `infrastructure.contextBudget.arena.zones.taskState`: `{ min: 0, max: 360 }`
- `infrastructure.contextBudget.arena.zones.toolFailures`: `{ min: 0, max: 480 }`
- `infrastructure.contextBudget.arena.zones.memoryWorking`: `{ min: 0, max: 300 }`
- `infrastructure.contextBudget.arena.zones.memoryRecall`: `{ min: 0, max: 600 }`
- `infrastructure.contextBudget.arena.zones.ragExternal`: `{ min: 0, max: 0 }`
- `infrastructure.toolFailureInjection.enabled`: `true`
- `infrastructure.toolFailureInjection.maxEntries`: `3`
- `infrastructure.toolFailureInjection.maxOutputChars`: `300`
- `infrastructure.interruptRecovery.enabled`: `true`
- `infrastructure.interruptRecovery.gracefulTimeoutMs`: `8000`
- `infrastructure.costTracking.enabled`: `true`
- `infrastructure.costTracking.maxCostUsdPerSession`: `0`
- `infrastructure.costTracking.alertThresholdRatio`: `0.8`
- `infrastructure.costTracking.actionOnExceed`: `warn`
- `infrastructure.turnWal.enabled`: `true`
- `infrastructure.turnWal.dir`: `.orchestrator/turn-wal`
- `infrastructure.turnWal.defaultTtlMs`: `300000`
- `infrastructure.turnWal.maxRetries`: `2`
- `infrastructure.turnWal.compactAfterMs`: `3600000`
- `infrastructure.turnWal.scheduleTurnTtlMs`: `600000`

### `ui`

- `ui.quietStartup`: `true`

## Security Policy Model

`security.mode` is a strategy-level control:

- `permissive`
  - Enforce denied tools
  - Disable allowlist/per-skill budget enforcement (`off`)
- `standard` (default)
  - Enforce denied tools
  - Keep allowlist/per-skill budget checks in warning mode (`warn`)
- `strict`
  - Enforce denied tools and all policy checks (`enforce`)

`security.sanitizeContext` independently controls user-text sanitization before skill selection and context injection.

`security.execution` controls command isolation for `exec`:

- `backend=auto` routes by mode (`permissive -> host`, `standard/strict -> sandbox`).
- `fallbackToHost` allows host downgrade only when the resolved backend is `sandbox` and neither `strict` nor `enforceIsolation=true` is active.
- `enforceIsolation=true` forces `backend=sandbox` and `fallbackToHost=false` regardless of mode/backend input.
- `strict` always disables host fallback even when `fallbackToHost=true` is configured.
- `exec.timeout` overrides `security.execution.sandbox.timeout` per command.
- `exec.workdir` and `exec.env` are forwarded into sandbox commands via a shell wrapper (`cd` + `export`).

### `security.execution` Resolution Order

At runtime, execution isolation is resolved in this order:

1. `BREWVA_ENFORCE_EXEC_ISOLATION` environment flag (`1`, `true`, `yes`, `on`)
2. `security.execution.enforceIsolation`
3. `security.mode === strict`
4. configured `security.execution.backend` and `security.execution.fallbackToHost`

This yields the following invariants:

- If `BREWVA_ENFORCE_EXEC_ISOLATION` is enabled, host fallback is disabled.
- If `enforceIsolation=true`, host fallback is disabled.
- If `security.mode=strict`, host fallback is disabled.
- `backend=host` is honored only when none of the above force sandbox.

### `security.execution` Routing Matrix

| mode       | backend | enforceIsolation | fallbackToHost | resolved backend | host fallback |
| ---------- | ------- | ---------------- | -------------- | ---------------- | ------------- |
| permissive | auto    | false            | true           | host             | n/a           |
| permissive | sandbox | false            | true           | sandbox          | true          |
| standard   | auto    | false            | true           | sandbox          | true          |
| standard   | sandbox | false            | false          | sandbox          | false         |
| strict     | any     | false            | any            | sandbox          | false         |
| any        | any     | true             | any            | sandbox          | false         |

Notes:

- `host fallback` applies only when the resolved backend is `sandbox`.
- Sandbox background process mode is unsupported; with fallback disabled this is fail-closed.
- If `exec.workdir` is omitted, sandbox execution defaults to `/` and does not inherit host runtime cwd.
- `commandDenyList` is a best-effort UX guard and is evaluated before backend execution; the hard boundary is sandbox isolation.

## Event Level Model

`infrastructure.events.level` controls default signal density:

- `audit`: only replay/audit-critical events
- `ops`: audit + operational state transitions/warnings
- `debug`: full stream (including high-noise diagnostics such as `viewport_*` and `cognitive_*`)

## Context Budget Model

With `infrastructure.contextBudget.enabled=true`, runtime enforces:

- primary injection cap (`maxInjectionTokens`)
- pressure thresholds (`compactionThresholdPercent`, `hardLimitPercent`)
- truncation policy (`truncationStrategy`)
- arena zone floor/cap allocation (`arena.zones.*`)
- adaptive zone control loop (`adaptiveZones.*`)
- floor-unmet recovery policy (`floorUnmetPolicy.*`)
- session arena SLO policy (`arena.maxEntriesPerSession`, `arena.degradationPolicy`)

`enabled=false` disables runtime token-budget enforcement for context injection.

Arena allocation behavior:

- Sources are planned by deterministic zone order:
  `identity -> truth -> task_state -> tool_failures -> memory_working -> memory_recall -> rag_external`.
- `zones.<zone>.min` is a floor for demanded content; `zones.<zone>.max` is a hard cap.
- If demanded floors exceed available injection budget, planner runs
  floor-relaxation cascade (`floorUnmetPolicy.relaxOrder`), then optional
  `critical_only` fallback before declaring unrecoverable floor unmet.
- Floor-unmet policy can request compaction explicitly
  (`floorUnmetPolicy.requestCompaction`), which bypasses normal cooldown.
- Adaptive zone controller updates per-session zone `max` overrides based on
  observed truncation/idle ratios (`adaptiveZones.*`), while allocator remains pure.
- Arena SLO ceiling (`arena.maxEntriesPerSession`) enforces deterministic
  degradation policy (`drop_recall | drop_low_priority | force_compact`).
- Memory recall can be pressure-gated by `memory.recallMode="fallback"`.
- External recall boundary is explicit and disabled by default:
  `memory.externalRecall.enabled=true` + non-zero `arena.zones.ragExternal.max`
  are both required for effective external injection.

Normalization details from `normalizeBrewvaConfig(...)`:

- `compactionThresholdPercent` is clamped to `<= hardLimitPercent`.
- Percent-like ratios are clamped into `[0, 1]` (`alertThresholdRatio`, memory/global confidence).
- `memory.retrievalWeights` are normalized to sum to `1` when total weight is positive; otherwise defaults are used.
- `memory.recallMode` is normalized to `primary | fallback` (invalid values fall back to defaults).
- `memory.externalRecall.*` is normalized to bounded numeric/boolean defaults.
- `arena.zones.<zone>.min/max` are normalized to non-negative integers and `max >= min`.
- `floorUnmetPolicy.relaxOrder` is normalized to valid zone names in deterministic order.
- `adaptiveZones.*` and compaction cooldown settings are clamped to safe numeric ranges.
- Most numeric fields are floor-normalized to positive/non-negative integers (invalid values fall back to defaults).

## Turn WAL Model

With `infrastructure.turnWal.enabled=true`, runtime and daemon surfaces can persist inbound/execution turns
to append-only JSONL WAL files under `infrastructure.turnWal.dir`.

- `defaultTtlMs` controls stale retry cutoff for normal turns.
- `scheduleTurnTtlMs` applies a longer default TTL for scheduled turns.
- `maxRetries` limits startup recovery replay attempts for pending/inflight rows.
- `compactAfterMs` controls retention window before terminal rows are compacted.

## Why-Based Public Surface

Several low-level tuning knobs were intentionally internalized and are no longer public configuration fields.

Examples:

- `memory.cognitive.maxInferenceCallsPerRefresh`
- `memory.cognitive.maxRankCandidatesPerSearch`
- `memory.cognitive.maxReflectionsPerVerification`
- `memory.global.minSessionRecurrence`
- `memory.global.decayIntervalDays`
- `memory.global.decayFactor`
- `memory.global.pruneBelowConfidence`
- `skills.selector.maxDigestTokens`
- `ledger.digestWindow`
- `tape.tapePressureThresholds.*`
- `parallel.maxTotal`
- `infrastructure.costTracking.maxCostUsdPerSkill`

If these keys are present in config files, schema validation emits diagnostics and runtime does not apply them.

## Config File Location and Merge Order

Default merge order (low to high precedence):

1. global: `$XDG_CONFIG_HOME/brewva/brewva.json` (or `~/.config/brewva/brewva.json`)
2. project: `<workspace>/.brewva/brewva.json`

If `--config` is provided, only that explicit file is loaded.

Relative paths in `skills.roots` are resolved from the directory of the config file that defines them.

Runtime artifact paths (for example `ledger.path`, `infrastructure.events.dir`) are resolved from runtime workspace root discovery (`nearest .brewva/brewva.json` or `.git` ancestor), not from nested package subdirectories.

## JSON Schema

For editor validation/completion:

```json
{
  "$schema": "../../node_modules/@brewva/brewva-runtime/schema/brewva.schema.json"
}
```

`$schema` is ignored by runtime behavior and used only for tooling.

## Validation and Diagnostics

On load, config JSON is schema-validated:

- parse errors and non-object roots are reported as errors
- unknown keys/type mismatches are reported as schema warnings
- runtime then normalizes/clamps values using `normalizeBrewvaConfig(...)`

This means malformed or removed fields are never silently applied as active runtime policy.

## Current Limitations

- Startup UI config currently exposes `ui.quietStartup` only; there is no `ui.collapseChangelog` field.
- Parallel session total-start cap is internal (`PARALLEL_MAX_TOTAL_PER_SESSION=10`) and not configurable via `BrewvaConfig`.
