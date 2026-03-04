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
- `skills.packs`: `[]`
- `skills.disabled`: `[]`
- `skills.overrides`: `{}`
- `skills.selector.k`: `4`
- `skills.cascade.mode`: `off` (`off | assist | auto`)
- `skills.cascade.enabledSources`: `["compose", "dispatch"]`
- `skills.cascade.sourcePriority`: `["compose", "dispatch"]`
- `skills.cascade.onMissingConsumes`: `replan` (`pause | replan | escalate`)
- `skills.cascade.maxStepsPerRun`: `8`
- `skills.cascade.maxReplans`: `2`

`skills.cascade.enabledSources` controls which sources are allowed to produce/replan chain intents.
`skills.cascade.sourcePriority` only controls arbitration order among enabled sources.

`skills.packs` is an optional allowlist for pack directories across all discovered skill roots
(`global_root`, `project_root`, and `config_root`).

- empty array (default): no pack filter, load all discovered packs
- non-empty array: strict allowlist, packs not listed are skipped

### `verification`

- `verification.defaultLevel`: `standard`
- `verification.checks.quick`: `["type-check"]`
- `verification.checks.standard`: `["type-check", "tests", "lint"]`
- `verification.checks.strict`: `["type-check", "tests", "lint", "diff-review"]`
- `verification.commands.type-check`: `bun run typecheck`
- `verification.commands.tests`: `bun test`
- `verification.commands.lint`: `bun run lint`
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
- `memory.recallMode`: `always`
- `memory.externalRecall.enabled`: `false`
- `memory.externalRecall.minInternalScore`: `0.62`
- `memory.externalRecall.queryTopK`: `5`
- `memory.externalRecall.injectedConfidence`: `0.6`
- `memory.evolvesMode`: `review-gated`
- `memory.cognitive.mode`: `shadow`
- `memory.cognitive.maxTokensPerTurn`: `4096` (`<=0` disables cognitive port calls)
- `memory.global.enabled`: `true`
- `memory.global.minConfidence`: `0.8`

### `security`

- `security.mode`: `standard`
- `security.sanitizeContext`: `true`
- `security.enforcement.allowedToolsMode`: `inherit`
- `security.enforcement.skillMaxTokensMode`: `inherit`
- `security.enforcement.skillMaxToolCallsMode`: `inherit`
- `security.enforcement.skillMaxParallelMode`: `inherit`
- `security.enforcement.skillDispatchGateMode`: `inherit`
- `security.execution.backend`: `best_available`
- `security.execution.enforceIsolation`: `false`
- `security.execution.fallbackToHost`: `false`
- `security.execution.commandDenyList`: `[]`
- `security.execution.sandbox.serverUrl`: `http://127.0.0.1:5555`
- `security.execution.sandbox.defaultImage`: `microsandbox/node`
- `security.execution.sandbox.memory`: `512`
- `security.execution.sandbox.cpus`: `1`
- `security.execution.sandbox.timeout`: `180`

`security.enforcement.*` controls per-policy behavior on top of `security.mode`:

- `inherit` (default): follow mode baseline
- `off`: disable that enforcement lane
- `warn`: emit warning events only
- `enforce`: block on violations

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
- `infrastructure.contextBudget.truncationStrategy`: `drop-low-fidelity`
- `infrastructure.contextBudget.compactionInstructions`: default operational compaction guidance string
- `infrastructure.contextBudget.compaction.minTurnsBetween`: `2`
- `infrastructure.contextBudget.compaction.minSecondsBetween`: `45`
- `infrastructure.contextBudget.compaction.pressureBypassPercent`: `0.94`
- `infrastructure.contextBudget.arena.maxEntriesPerSession`: `4096`
- `infrastructure.toolFailureInjection.enabled`: `true`
- `infrastructure.toolFailureInjection.maxEntries`: `3`
- `infrastructure.toolFailureInjection.maxOutputChars`: `300`
- `infrastructure.toolOutputDistillationInjection.enabled`: `true`
- `infrastructure.toolOutputDistillationInjection.maxEntries`: `3`
- `infrastructure.toolOutputDistillationInjection.maxOutputChars`: `300`
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

Runtime reserves a small set of control-plane tools (for example `skill_complete`, `session_compact`, and tape/ledger inspection tools) that bypass skill allowlists and per-skill budget enforcement to avoid deadlocks during recovery. These tools may still be blocked by the critical context compaction gate.

`security.execution` controls command isolation for `exec`:

- `backend=best_available` prefers sandbox first; host fallback is implicit (always allowed unless strict/enforced isolation).
- `backend=sandbox` is isolation-first; host fallback is controlled by `fallbackToHost` (`false` by default).
- `enforceIsolation=true` forces `backend=sandbox` and disables host fallback regardless of other inputs.
- `strict` always disables host fallback.
- `exec.timeout` overrides `security.execution.sandbox.timeout` per command.
- `exec.workdir` and `exec.env` are forwarded into sandbox commands via a shell wrapper (`cd` + `export`).

### `security.execution` Resolution Order

At runtime, execution isolation is resolved in this order:

1. `BREWVA_ENFORCE_EXEC_ISOLATION` environment flag (`1`, `true`, `yes`, `on`)
2. `security.execution.enforceIsolation`
3. `security.mode === strict`
4. configured `security.execution.backend`
5. `security.execution.fallbackToHost` (when resolved backend is `sandbox`)

This yields the following invariants:

- If `BREWVA_ENFORCE_EXEC_ISOLATION` is enabled, host fallback is disabled.
- If `enforceIsolation=true`, host fallback is disabled.
- If `security.mode=strict`, host fallback is disabled.
- `backend=best_available` routes `sandbox` first and implicitly allows host fallback.
- `backend=host` is honored only when none of the above force sandbox.

### `security.execution` Routing Matrix

| mode       | backend        | enforceIsolation | fallbackToHost | resolved backend | host fallback |
| ---------- | -------------- | ---------------- | -------------- | ---------------- | ------------- |
| permissive | best_available | false            | any            | sandbox          | true          |
| standard   | best_available | false            | any            | sandbox          | true          |
| standard   | sandbox        | false            | false          | sandbox          | false         |
| standard   | sandbox        | false            | true           | sandbox          | true          |
| strict     | any            | false            | any            | sandbox          | false         |
| any        | any            | true             | any            | sandbox          | false         |

Notes:

- `host fallback` applies only when the resolved backend is `sandbox`.
- `backend=best_available` implicitly enables host fallback; `fallbackToHost` controls fallback for explicit `backend=sandbox`.
- Sandbox background process mode is unsupported; with fallback disabled this is fail-closed.
- When sandbox execution fails and host fallback is enabled, runtime applies a short backoff window before retrying sandbox (`exec_fallback_host.reason=sandbox_unavailable_cached`) to avoid repeated sandbox error churn.
- Repeated sandbox failures in the same session can trigger a temporary session pin (`exec_fallback_host.reason=sandbox_unavailable_session_pinned`) so subsequent exec calls bypass sandbox until the pin TTL expires.
- If `exec.workdir` is omitted, sandbox execution defaults to `/` and does not inherit host runtime cwd.
- `commandDenyList` is a best-effort UX guard and is evaluated before backend execution; the hard boundary is sandbox isolation.

## Event Level Model

`infrastructure.events.level` controls default signal density:

- `audit`: only replay/audit-critical events
- `ops`: audit + operational state transitions/warnings
- `debug`: full stream (including high-noise diagnostics such as most `cognitive_*`)
- `cognitive_relevance_ranking*` stays visible at `ops` for rerank evaluation.

## Context Budget Model

With `infrastructure.contextBudget.enabled=true`, runtime enforces:

- primary injection cap (`maxInjectionTokens`)
- pressure thresholds (`compactionThresholdPercent`, `hardLimitPercent`)
- truncation policy (`truncationStrategy`)
- session arena SLO policy (`arena.maxEntriesPerSession`)

`enabled=false` disables runtime token-budget enforcement for context injection.

Runtime behavior:

- Context injection uses a single deterministic path:
  global cap + hard-limit gate + arena SLO (`arena.maxEntriesPerSession`).
- When pressure is `critical` and no recent compaction has been performed, runtime arms a compaction gate:
  tool calls are blocked until `session_compact` is performed (only `session_compact` and `skill_complete` bypass the gate).
- Memory recall can be pressure-gated by `memory.recallMode="pressure-aware"`.
- External recall boundary is explicit and disabled by default:
  set `memory.externalRecall.enabled=true` and inject a custom
  `externalRecallPort`.
- External recall executes only when all runtime gates pass:
  `pressure allowed` + active skill has `external-knowledge` tag +
  `internalTopScore < minInternalScore` + provider is available.
- All skip outcomes (including `skill_tag_missing`) emit
  `context_external_recall_decision` at `ops` level.
- Runtime never auto-wires a built-in external recall provider.

Normalization details from `normalizeBrewvaConfig(...)`:

- Key numeric ranges are schema-enforced fail-fast (for example confidence ratios, schedule limits, context budget limits, and memory bounds).
- `compactionThresholdPercent` is still clamped to `<= hardLimitPercent` after schema validation.
- `memory.retrievalWeights` are normalized to sum to `1` when total weight is positive; otherwise defaults are used.
- Integer-like counters are floor-normalized when already in-range (for example `dailyRefreshHourLocal: 12.7 -> 12`).
- `memory.recallMode` only accepts `always | pressure-aware`; invalid values fail config load.
- `memory.evolvesMode` only accepts `off | review-gated`; invalid values fail config load.
- `truncationStrategy` only accepts `drop-entry | drop-low-fidelity | tail`; unknown values fail config load.

## Cost Tracking Model

With `infrastructure.costTracking.enabled=true`, runtime records usage and applies
session-level budget policy (`maxCostUsdPerSession`, `alertThresholdRatio`,
`actionOnExceed`).

With `infrastructure.costTracking.enabled=false`:

- usage accounting remains active (`totalTokens`, `totalCostUsd`, model/skill/tool totals)
- session budget blocking is disabled (`budget.blocked=false`, `budget.sessionExceeded=false`)
- budget alerts are suppressed (`alerts=[]`)

`maxCostUsdPerSession=0` also results in no session-cap exceed condition, but
`enabled` is the explicit policy switch for whether budget enforcement/alerts run.

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

If these keys are present in config files, schema validation fails startup and runtime does not apply them.

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

## Validation and Failure Behavior

On load, config JSON is schema-validated:

- parse errors and non-object roots are startup-blocking
- schema mismatches (including unknown keys/type mismatches) are startup-blocking
- schema loader failures are startup-blocking
- runtime normalization (`normalizeBrewvaConfig(...)`) runs only after schema validation passes

This means malformed or removed fields are never silently applied as active runtime policy.

## Current Limitations

- Startup UI config currently exposes `ui.quietStartup` only; there is no `ui.collapseChangelog` field.
- Parallel session total-start cap is internal (`PARALLEL_MAX_TOTAL_PER_SESSION=10`) and not configurable via `BrewvaConfig`.
