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
- `tape`
- `security`
- `parallel`
- `infrastructure`

## Key Defaults

- `skills.roots`: `[]` (optional additional skill root directories; relative paths in config files are resolved from that config file's directory)
- `skills.packs`: `typescript`, `react`, `bun`
- `verification.defaultLevel`: `standard`
- `ledger.path`: `.orchestrator/ledger/evidence.jsonl`
- `tape.checkpointIntervalEntries`: `120`
- `tape.tapePressureThresholds.low`: `80`
- `tape.tapePressureThresholds.medium`: `160`
- `tape.tapePressureThresholds.high`: `280`
- `parallel.maxConcurrent`: `3`
- `parallel.maxTotal`: `10`
- `infrastructure.events.dir`: `.orchestrator/events`
- `infrastructure.contextBudget.truncationStrategy`: `summarize`
- `infrastructure.contextBudget.minSecondsBetweenCompaction`: `45`
- `infrastructure.contextBudget.pressureBypassPercent`: `0.94`
- `infrastructure.interruptRecovery.enabled`: `true`
- `infrastructure.interruptRecovery.gracefulTimeoutMs`: `8000`

## Skill Discovery

Skill loading is root-aware and merges from multiple sources (lowest to highest
precedence):

1. global config root (`$XDG_CONFIG_HOME/pi-roaster` or `~/.config/pi-roaster`)
2. project root (`<cwd>/.pi-roaster`)
3. explicit `skills.roots` entries

For each discovered root, runtime accepts either:

- `<root>/skills/{base,packs,project}`
- `<root>/{base,packs,project}`

Pack loading behavior:

- module/executable/global roots: load only packs listed in `skills.packs`
- project/config roots: load all discovered packs (to include local custom
  packs without extra config churn)

## Context Budget Behavior

- `infrastructure.contextBudget.enabled=false` disables runtime context-budget enforcement for:
  - primary context injection token caps
  - supplemental context injection token caps
  - compaction threshold / hard-limit decisions
- `maxInjectionTokens` and related thresholds apply only when `enabled=true`.

## Config File Location

Default project config path: `.pi-roaster/roaster.json`.
By default, runtime merges global config from `~/.config/pi-roaster/roaster.json` and then project config from `.pi-roaster/roaster.json`; project values override global values on conflicts.

Loading behavior is implemented in `packages/roaster-runtime/src/config/loader.ts`.

## JSON Schema

To enable editor completion and validation for `.pi-roaster/roaster.json`, set `$schema` to the schema file shipped with the runtime package:

```json
{
  "$schema": "../../node_modules/@pi-roaster/roaster-runtime/schema/roaster.schema.json"
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

## Tool Scan Parallelism

Runtime-aware multi-file read scans in tool implementations derive their
concurrency from `parallel`:

- `parallel.enabled=false`: force sequential scan reads (`batchSize=1`).
- `parallel.enabled=true`: scan batch size is derived from
  `parallel.maxConcurrent * 4` and clamped to `[1, 64]`.
- During scans, tools adapt per-batch reads to remaining match budget so
  low-limit queries avoid eager over-read.

These scans emit `tool_parallel_read` events with the effective mode, batch
size, and per-run read telemetry. See `docs/reference/events.md`.
