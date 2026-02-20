# Reference: Configuration

Configuration contract sources:

- Default values: `packages/brewva-runtime/src/config/defaults.ts`
- Loader entrypoint: `packages/brewva-runtime/src/config/loader.ts`
- Type contract: `packages/brewva-runtime/src/types.ts`

## Top-Level Keys

`BrewvaConfig` supports the following top-level keys:

- `skills`
- `verification`
- `ledger`
- `tape`
- `security`
- `parallel`
- `infrastructure`
- `ui`

Configuration files use patch/overlay semantics: only specify fields you want
to override; unspecified fields are inherited from defaults and lower-precedence
configuration layers.

## Key Defaults

Defaults are defined in `packages/brewva-runtime/src/config/defaults.ts`.

### Skills

- `skills.roots`: `[]` (optional additional skill root directories; relative paths in config files are resolved from that config file's directory)
- `skills.packs`: `["typescript", "react", "bun", "skill-creator"]`
- `skills.disabled`: `[]`
- `skills.overrides`: `{}`
- `skills.selector.k`: `4`
- `skills.selector.maxDigestTokens`: `1200`

### Verification

- `verification.defaultLevel`: `standard`
- `verification.checks.quick`: `["type-check"]`
- `verification.checks.standard`: `["type-check", "tests", "lint"]`
- `verification.checks.strict`: `["type-check", "tests", "lint", "diff-review"]`
- `verification.commands.type-check`: `bun run typecheck`
- `verification.commands.tests`: `bun test`
- `verification.commands.lint`: `bunx tsc --noEmit`
- `verification.commands.diff-review`: `git diff --stat`

### Ledger

- `ledger.path`: `.orchestrator/ledger/evidence.jsonl`
- `ledger.digestWindow`: `12`
- `ledger.checkpointEveryTurns`: `20`

### Tape

- `tape.checkpointIntervalEntries`: `120`
- `tape.tapePressureThresholds.low`: `80`
- `tape.tapePressureThresholds.medium`: `160`
- `tape.tapePressureThresholds.high`: `280`

### Parallel

- `parallel.enabled`: `true`
- `parallel.maxConcurrent`: `3`
- `parallel.maxTotal`: `10`

### Infrastructure

- `infrastructure.events.enabled`: `true`
- `infrastructure.events.dir`: `.orchestrator/events`
- `infrastructure.contextBudget.enabled`: `true`
- `infrastructure.contextBudget.maxInjectionTokens`: `1200`
- `infrastructure.contextBudget.compactionThresholdPercent`: `0.82`
- `infrastructure.contextBudget.hardLimitPercent`: `0.94`
- `infrastructure.contextBudget.minTurnsBetweenCompaction`: `2`
- `infrastructure.contextBudget.minSecondsBetweenCompaction`: `45`
- `infrastructure.contextBudget.pressureBypassPercent`: `0.94`
- `infrastructure.contextBudget.truncationStrategy`: `summarize`
- `infrastructure.interruptRecovery.enabled`: `true`
- `infrastructure.interruptRecovery.gracefulTimeoutMs`: `8000`
- `infrastructure.costTracking.enabled`: `true`
- `infrastructure.costTracking.maxCostUsdPerSession`: `0`
- `infrastructure.costTracking.maxCostUsdPerSkill`: `0`
- `infrastructure.costTracking.alertThresholdRatio`: `0.8`
- `infrastructure.costTracking.actionOnExceed`: `warn`

### UI

- `ui.quietStartup`: `true`
- `ui.collapseChangelog`: `true`

## Skill Discovery

Skill loading is root-aware and merges from multiple sources (lowest to highest
precedence):

1. module ancestors (bounded to depth 10 from the runtime module path)
2. executable ancestors (bounded to depth 10 from `process.execPath`)
3. global Brewva root (`$XDG_CONFIG_HOME/brewva` or `~/.config/brewva`)
4. project root (`<cwd>/.brewva`)
5. explicit `skills.roots` entries (relative paths are resolved from the config file that declared them)

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

Default project config path: `.brewva/brewva.json`.
By default, runtime merges global config from `$XDG_CONFIG_HOME/brewva/brewva.json` (or `~/.config/brewva/brewva.json`) and then project config from `.brewva/brewva.json`; project values override global values on conflicts.

Loading behavior is implemented in `packages/brewva-runtime/src/config/loader.ts`.

Relative runtime artifact paths (for example `ledger.path`, `infrastructure.events.dir`, and rollback snapshots under `.orchestrator`) are resolved from the workspace root selected by runtime path discovery (`nearest .brewva/brewva.json` or `.git` ancestor), not from a nested package subdirectory.

Global root resolution can be overridden via `BREWVA_CODING_AGENT_DIR`. See `packages/brewva-runtime/src/config/paths.ts`.

## JSON Schema

To enable editor completion and validation for `.brewva/brewva.json`, set `$schema` to the schema file shipped with the runtime package:

```json
{
  "$schema": "../../node_modules/@brewva/brewva-runtime/schema/brewva.schema.json"
}
```

If you store the config file elsewhere (for example via `--config`), adjust the relative path accordingly.

## Validation and Diagnostics

- On startup, configuration files are validated against the schema. If unknown
  fields or type mismatches are detected, warnings are emitted (up to 3 by
  default; use `--verbose` to print all warnings).
- `$schema` is only used for editor completion and validation hints, and is
  ignored at runtime.

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
- `security.skillMaxToolCallsMode`: `off` | `warn` | `enforce` (default `warn`).
  - `off`: Do not apply the per-skill `budget.maxToolCalls` contract at runtime.
  - `warn`: Once a skill reaches/exceeds `maxToolCalls`, allow tool calls but emit a `skill_budget_warning` event once per (session, skill).
  - `enforce`: Once a skill reaches/exceeds `maxToolCalls`, block non-lifecycle tools while still allowing always-allowed lifecycle tools.
- `security.skillMaxParallelMode`: `off` | `warn` | `enforce` (default `warn`).
  - `off`: Do not apply the per-skill `maxParallel` contract; only the global `parallel.*` limits apply.
  - `warn`: When a skill reaches/exceeds `maxParallel` active runs, allow acquisitions but emit a `skill_parallel_warning` event once per (session, skill).
  - `enforce`: Reject `BrewvaRuntime.acquireParallelSlot()` calls once `maxParallel` is reached, returning `reason=skill_max_parallel`.

## Tool Scan Parallelism

Runtime-aware multi-file read scans in tool implementations derive their
concurrency from `parallel`:

- `parallel.enabled=false`: force sequential scan reads (`batchSize=1`).
- `parallel.enabled=true`: scan batch size is derived from
  `min(parallel.maxConcurrent, parallel.maxTotal) * 4` and clamped to `[1, 64]`.
- During scans, tools adapt per-batch reads to remaining match budget so
  low-limit queries avoid eager over-read.

These scans emit `tool_parallel_read` events with the effective mode, batch
size, and per-run read telemetry. See `docs/reference/events.md`.
