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
- `run` (alias of `start`)
- `install`
- `uninstall`
- `status`
- `stop`
- `heartbeat-reload`
- `rotate-token`
- `logs`

This subcommand set covers local daemon lifecycle management, OS supervisor bootstrap, health probing, token rotation, and log access. It is distinct from `--channel`.
Protocol and method reference: `docs/reference/gateway-control-plane-protocol.md`.  
Operational guide: `docs/guide/gateway-control-plane-daemon.md`.
Gateway CLI implementation source: `packages/brewva-gateway/src/cli.ts`.

Loopback-only host policy applies to gateway start/probe/control (`--host` must resolve to `localhost`, `127.0.0.1`, or `::1`).

### Gateway Subcommand Flags

`brewva gateway start` / `run`:

- `--detach`
- `--foreground`
- `--wait-ms`
- `--cwd`
- `--config`
- `--model`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--log-file`
- `--token-file`
- `--heartbeat`
- `--no-extensions`
- `--json`
- `--tick-interval-ms`
- `--session-idle-ms`
- `--max-workers`
- `--max-open-queue`
- `--max-payload-bytes`
- `--health-http-port`
- `--health-http-path`

`brewva gateway install`:

- `--json`
- `--launchd`
- `--systemd`
- `--no-start`
- `--dry-run`
- `--cwd`
- `--config`
- `--model`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--log-file`
- `--token-file`
- `--heartbeat`
- `--no-extensions`
- `--tick-interval-ms`
- `--session-idle-ms`
- `--max-workers`
- `--max-open-queue`
- `--max-payload-bytes`
- `--health-http-port`
- `--health-http-path`
- `--label`
- `--service-name`
- `--plist-file`
- `--unit-file`

`brewva gateway uninstall`:

- `--json`
- `--launchd`
- `--systemd`
- `--dry-run`
- `--label`
- `--service-name`
- `--plist-file`
- `--unit-file`

`brewva gateway status`:

- `--json`
- `--deep`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway stop`:

- `--json`
- `--force`
- `--reason`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway heartbeat-reload`:

- `--json`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway rotate-token`:

- `--json`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway logs`:

- `--json`
- `--state-dir`
- `--log-file`
- `--tail`

### Gateway Flag Validation Notes

- `--port`: integer in `[1, 65535]`.
- `--wait-ms` (start): integer `>= 200`.
- `--tick-interval-ms` (start): integer `>= 1000`.
- `--session-idle-ms` (start): integer `>= 1000`.
- `--max-payload-bytes` (start): integer `>= 16384`.
- `--max-workers` (start): integer `>= 1`.
- `--max-open-queue` (start): integer `>= 0`.
- `--health-http-port` (start/install): integer in `[1, 65535]`.
- `--timeout-ms` (status/stop/heartbeat-reload/rotate-token): integer `>= 100`.
- `--tail` (logs): integer `>= 1`.

Platform notes for supervisor install:

- macOS defaults to `launchd` and writes `~/Library/LaunchAgents/com.brewva.gateway.plist`.
- Linux defaults to `systemd --user` and writes `~/.config/systemd/user/brewva-gateway.service`.
- `--launchd` and `--systemd` are mutually exclusive.
- `--no-start` writes service files but skips `load` / `enable --now`.

### Gateway Exit Code Notes

- `brewva gateway status`: `0` reachable, `1` not running/invalid input, `2` process alive but probe failed.
- `brewva gateway stop`: `0` stopped (or already not running), `2` process still alive after timeout/fallback.
- `brewva gateway install`: `0` success, `1` invalid input or supervisor operation failure.
- `brewva gateway uninstall`: `0` success, `1` invalid input.

## Subcommand: `brewva onboard`

`brewva onboard` is a convenience wrapper over `brewva gateway install/uninstall`.

- `brewva onboard --install-daemon`: install daemon service for current OS (macOS `launchd`, Linux `systemd --user`).
- `brewva onboard --uninstall-daemon`: remove daemon service.

Shared flags mirror gateway install/uninstall:

- `--launchd` / `--systemd`
- `--no-start`
- `--dry-run`
- `--json`
- `--cwd`, `--config`, `--model`, `--host`, `--port`, `--state-dir`
- `--pid-file`, `--log-file`, `--token-file`, `--heartbeat`
- `--tick-interval-ms`, `--session-idle-ms`, `--max-workers`, `--max-open-queue`, `--max-payload-bytes`
- `--health-http-port`, `--health-http-path`
- `--label`, `--service-name`, `--plist-file`, `--unit-file`

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
- `--agent`
- `--task`
- `--task-file`
- `--no-extensions`
- `--print`
- `--interactive`
- `--mode`
- `--backend`
- `--json`
- `--undo`
- `--replay`
- `--daemon`
- `--channel`
- `--install-daemon`
- `--uninstall-daemon`
- `--launchd`
- `--systemd`
- `--no-start`
- `--dry-run`
- `--telegram-token`
- `--telegram-callback-secret`
- `--telegram-poll-timeout`
- `--telegram-poll-limit`
- `--telegram-poll-retry-ms`
- `--pid-file`
- `--log-file`
- `--token-file`
- `--heartbeat`
- `--tick-interval-ms`
- `--session-idle-ms`
- `--max-workers`
- `--max-open-queue`
- `--max-payload-bytes`
- `--health-http-port`
- `--health-http-path`
- `--label`
- `--service-name`
- `--plist-file`
- `--unit-file`
- `--session`
- `--verbose`
- `--version`
- `--help`

Short aliases:

- `-p` for `--print`
- `-i` for `--interactive`
- `-v` for `--version`
- `-h` for `--help`

`--no-extensions` disables presentation-oriented extension handlers. Runtime
core bridge hooks remain active for tool policy, compaction gate, and
ledger/patch tracking. A minimal autonomy context contract plus tape/context
pressure status injection remains active in this profile.

`--backend` controls the primary session backend:

- `auto` (default): for print-text mode, try gateway first and fall back to embedded only for pre-ack failures.
- `embedded`: always use local in-process sessions.
- `gateway`: force gateway path (currently supports print-text mode only).

Current constraints for `--backend gateway`:

- interactive mode is not supported.
- JSON mode (`--mode json` / `--json`) is not supported.
- `--undo`, `--replay`, `--daemon`, and `--channel` combinations are not supported.
- `--task` / `--task-file` combinations are not supported.
- Under `--backend auto`, task-based runs skip gateway and use embedded directly.

Advanced gateway discovery overrides (environment variables):

- `BREWVA_GATEWAY_STATE_DIR`
- `BREWVA_GATEWAY_PID_FILE`
- `BREWVA_GATEWAY_TOKEN_FILE`
- `BREWVA_GATEWAY_HOST`
- `BREWVA_GATEWAY_PORT`

Channel mode examples:

- `bun run start -- --channel telegram --telegram-token <bot-token>`
- `bun run start -- --channel tg --telegram-token <bot-token> --telegram-poll-timeout 15`

## Input Resolution Rules

- `--task` and `--task-file` are mutually exclusive; providing both returns an error.
- `--agent` selects `.brewva/agents/<agent-id>/identity.md` for session identity injection.
- Agent id precedence is: `--agent` -> `BREWVA_AGENT_ID` -> `default`.
- If both a TaskSpec and prompt text are provided, prompt text overrides `TaskSpec.goal`.
- If stdin/stdout is not a TTY and no explicit mode is set, CLI falls back to text print mode.
- Explicit `--interactive` requires a TTY terminal.
- `--replay` uses `--session` when provided; otherwise it replays the latest replayable session.
- `--undo` uses `--session` when provided; otherwise it resolves the latest session with rollback history.
- `--replay` and `--undo` are mutually exclusive.
- `--replay`/`--undo` cannot be combined with `--task`/`--task-file`.
- Prompt text is ignored in `--replay` and `--undo` flows.
- Replay JSON output is event-per-line; the `brewva_event_bundle` record is only emitted for one-shot JSON runs.
- CLI parse/pre-session validation failures return exit code `1`.
- `--help` and `--version` return exit code `0`.

## Startup Defaults

- Interactive mode defaults to quiet startup (reducing banner/changelog/version-check output).
- Startup UI defaults are sourced from `BrewvaConfig.ui` and applied by `@brewva/brewva-cli`.
- Use `--verbose` to explicitly enable detailed startup output.
- To temporarily restore version-check notifications, run: `PI_SKIP_VERSION_CHECK= bun run start`.
