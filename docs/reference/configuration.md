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
- `infrastructure`
- `ui`

Configuration files are patch overlays: omitted fields inherit defaults/lower-precedence layers.

## Key Defaults

### `skills`

- `skills.roots`: `[]`
- `skills.packs`: `["skill-creator"]`
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
- `memory.evolvesMode`: `shadow`
- `memory.cognitive.mode`: `active`
- `memory.cognitive.maxTokensPerTurn`: `0` (`0` means unlimited)
- `memory.global.enabled`: `true`
- `memory.global.minConfidence`: `0.8`

### `security`

- `security.mode`: `standard`
- `security.sanitizeContext`: `true`

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

`enabled=false` disables runtime token-budget enforcement for context injection.

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
- `infrastructure.contextBudget.minTurnsBetweenCompaction`
- `infrastructure.contextBudget.minSecondsBetweenCompaction`
- `infrastructure.contextBudget.pressureBypassPercent`
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
