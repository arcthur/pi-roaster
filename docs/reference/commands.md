# Reference: Commands (CLI Surface)

Brewva does not expose a slash-command registry. Its command surface is the CLI flag set.

Implementation source: `packages/brewva-cli/src/index.ts`.

## Mode Commands

- Interactive mode (default)
- Print text mode (`--print`)
- Print JSON mode (`--mode json`, `--json`; newline-delimited JSON output, plus final `brewva_event_bundle` for one-shot runs)
- Undo mode (`--undo`)
- Replay mode (`--replay`)
- Scheduler daemon mode (`--daemon`)
- Channel gateway mode (`--channel`)

## Subcommand: `brewva gateway`

The primary CLI also exposes control-plane subcommands via `brewva gateway ...`.

- `start`
- `status`
- `stop`
- `heartbeat-reload`
- `rotate-token`
- `logs`

This subcommand set covers local daemon lifecycle management, health probing, token rotation, and log access. It is distinct from `--channel`.
Protocol and method reference: `docs/reference/gateway-control-plane-protocol.md`.  
Operational guide: `docs/guide/gateway-control-plane-daemon.md`.

`--daemon` executes due intents in child sessions (lineage-aware wakeups) and
handles graceful shutdown by aborting active child runs on signals.
Daemon mode rejects incompatible input surfaces:

- `--print` / `--json` / `--mode` (non-interactive)
- `--undo` / `--replay`
- `--task` / `--task-file`
- inline prompt text

`--channel` runs channel gateway orchestration.
Supported channel ids are `telegram` and alias `tg`.
Channel mode rejects incompatible input surfaces:

- `--daemon`
- `--undo` / `--replay`
- `--task` / `--task-file`
- `--print` / `--json` / `--mode`
- inline prompt text

`--channel telegram` requires `--telegram-token`.
`--telegram-callback-secret`, `--telegram-poll-timeout`, `--telegram-poll-limit`,
and `--telegram-poll-retry-ms` are optional tuning flags.

Daemon startup also requires:

- `schedule.enabled=true`
- `infrastructure.events.enabled=true`

On startup recovery, catch-up execution is bounded by
`schedule.maxRecoveryCatchUps`; overflow missed intents are deferred with
`intent_updated` projection writes plus `schedule_recovery_deferred` telemetry
events. Daemon recovery also emits per-session `schedule_recovery_summary`
events.
With `--verbose`, daemon prints a rolling 60-second scheduler window summary
(`fired/errored/deferred/circuit_opened` plus child-session lifecycle counts).

## Flags

- `--cwd`
- `--config`
- `--model`
- `--task`
- `--task-file`
- `--no-extensions`
- `--print`
- `--interactive`
- `--mode`
- `--json`
- `--undo`
- `--replay`
- `--daemon`
- `--channel`
- `--telegram-token`
- `--telegram-callback-secret`
- `--telegram-poll-timeout`
- `--telegram-poll-limit`
- `--telegram-poll-retry-ms`
- `--session`
- `--verbose`
- `--help`

Short aliases:

- `-p` for `--print`
- `-i` for `--interactive`
- `-h` for `--help`

`--no-extensions` disables presentation-oriented extension handlers. Runtime
core bridge hooks remain active for tool policy, compaction gate, and
ledger/patch tracking.

Channel mode examples:

- `bun run start -- --channel telegram --telegram-token <bot-token>`
- `bun run start -- --channel tg --telegram-token <bot-token> --telegram-poll-timeout 15`

## Input Resolution Rules

- `--task` and `--task-file` are mutually exclusive; providing both returns an error.
- If both a TaskSpec and prompt text are provided, prompt text overrides `TaskSpec.goal`.
- If stdin/stdout is not a TTY and no explicit mode is set, CLI falls back to text print mode.
- Explicit `--interactive` requires a TTY terminal.
- `--replay` uses `--session` when provided; otherwise it replays the latest replayable session.
- `--undo` uses `--session` when provided; otherwise it resolves the latest session with rollback history.
- Prompt text is ignored in `--replay` and `--undo` flows.
- Replay JSON output is event-per-line; the `brewva_event_bundle` record is only emitted for one-shot JSON runs.

## Startup Defaults

- Interactive mode defaults to quiet startup (reducing banner/changelog/version-check output).
- Startup UI defaults are sourced from `BrewvaConfig.ui` and applied by `@brewva/brewva-cli`.
- Use `--verbose` to explicitly enable detailed startup output.
- To temporarily restore version-check notifications, run: `PI_SKIP_VERSION_CHECK= bun run start`.
