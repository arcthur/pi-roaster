# CLI

CLI implementation: `packages/brewva-cli/src/index.ts`.

## Execution Modes

- Interactive mode (default)
- One-shot text mode (`--print`)
- One-shot JSON mode (`--mode json` or `--json`; newline-delimited JSON output, plus final `brewva_event_bundle`)
- Undo mode (`--undo`)
- Replay mode (`--replay`)
- Scheduler daemon mode (`--daemon`)
- Channel gateway mode (`--channel`)

## Gateway Subcommand (`brewva gateway`)

In addition to `brewva [flags]` primary modes, the CLI exposes control-plane subcommands:

- `brewva gateway start`
- `brewva gateway install`
- `brewva gateway uninstall`
- `brewva gateway status`
- `brewva gateway stop`
- `brewva gateway heartbeat-reload`
- `brewva gateway rotate-token`
- `brewva gateway logs`

`brewva gateway` and `--channel` are different execution paths: the former is the local control-plane daemon, while the latter is channel ingress/egress orchestration.
For operational details, see `docs/guide/gateway-control-plane-daemon.md`.

## Onboard Subcommand (`brewva onboard`)

`brewva onboard` is a wrapper around gateway service lifecycle:

- `brewva onboard --install-daemon`
- `brewva onboard --uninstall-daemon`

Useful flags:

- `--launchd` / `--systemd`
- `--no-start`
- `--dry-run`
- `--json`

## Startup Behavior

- Interactive mode defaults to quiet startup, reducing banner/changelog/version-check noise during initialization.
- Startup UI behavior is controlled by `BrewvaConfig.ui` (`ui.quietStartup`) and applied by `@brewva/brewva-cli`.

## Mode and Input Resolution

- `--task` and `--task-file` are mutually exclusive.
- If both TaskSpec and prompt text are provided, prompt text overrides `TaskSpec.goal`.
- When stdin/stdout is not a TTY and no explicit mode is selected, CLI falls back to text print mode.
- Explicit `--interactive` requires a TTY terminal and exits with an error otherwise.
- `--replay`/`--undo` default to auto-resolved sessions when `--session` is omitted.
- `--replay` and `--undo` are mutually exclusive.
- `--replay`/`--undo` cannot be combined with `--task`/`--task-file`.
- CLI parse/validation failures return non-zero exit code (`1`).
- `--help` and `--version` return success exit code (`0`).

## Flags

- `--cwd`
- `--config`
- `--model`
- `--agent`
- `--task`
- `--task-file`
- `--no-addons`
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

`--no-addons` disables the full extension orchestration layer.
CLI still installs runtime core bridge hooks, so tool policy, compaction gate,
and ledger/patch tracking remain enforced.

Retained: `before_agent_start` core status/context block, `tool_call`,
`tool_result`, `session_compact`, `session_shutdown`.

Disabled: `registerContextTransform` (`turn_start`/`context` governance lifecycle),
`registerCompletionGuard`, `registerEventStream`, `registerNotification`.

`--backend` selects the primary session backend:

- `auto` (default): for `--print`, try gateway first then fall back to embedded only on pre-ack failures.
- `embedded`: always run local in-process session.
- `gateway`: force gateway path (currently supports `--print` only).

Current backend constraints:

- `--backend gateway` is rejected for interactive mode.
- `--backend gateway` is rejected for `--mode json`.
- `--backend gateway` is rejected with `--undo`, `--replay`, `--daemon`, and `--channel`.
- `--backend gateway` is rejected with `--task` / `--task-file`.
- `--backend auto` skips gateway when `--task` / `--task-file` is provided.

Advanced gateway discovery overrides (environment variables):

- `BREWVA_GATEWAY_STATE_DIR`
- `BREWVA_GATEWAY_PID_FILE`
- `BREWVA_GATEWAY_TOKEN_FILE`
- `BREWVA_GATEWAY_HOST`
- `BREWVA_GATEWAY_PORT`

`--verbose` overrides quiet startup and emits the full startup output.

`--daemon` runs a scheduler process for intent execution without creating an
interactive coding session. Due intents are executed in child sessions with
wakeup context and continuity metadata.
It cannot be combined with `--print`/`--json`/`--mode`, `--undo`/`--replay`,
`--task`/`--task-file`, or inline prompt text.
It also requires `schedule.enabled=true` and `infrastructure.events.enabled=true`.

`--channel` runs gateway mode for channel ingress/egress.
Current supported value is `telegram` (alias `tg`).
It cannot be combined with `--daemon`, `--undo`/`--replay`, `--task`/`--task-file`,
non-interactive output flags (`--print`/`--json`/`--mode`), or inline prompt text.
For `--channel telegram`, `--telegram-token` is required.
Other Telegram flags are optional and mapped into channel-scoped config:
`channelConfig.telegram.callbackSecret`,
`channelConfig.telegram.pollTimeoutSeconds`,
`channelConfig.telegram.pollLimit`,
`channelConfig.telegram.pollRetryMs`.
Telegram channel skill policy does not currently have dedicated CLI flags; it is read from
built-in default skill `telegram`.

Webhook ingress can be enabled via environment variables (no additional CLI flags):

- `BREWVA_TELEGRAM_WEBHOOK_ENABLED=1`
- `BREWVA_TELEGRAM_INGRESS_HOST`
- `BREWVA_TELEGRAM_INGRESS_PORT`
- `BREWVA_TELEGRAM_INGRESS_PATH`
- `BREWVA_TELEGRAM_INGRESS_MAX_BODY_BYTES`
- `BREWVA_TELEGRAM_INGRESS_AUTH_MODE` (`hmac|bearer|both`)
- `BREWVA_TELEGRAM_INGRESS_BEARER_TOKEN`
- `BREWVA_TELEGRAM_INGRESS_HMAC_SECRET`
- `BREWVA_TELEGRAM_INGRESS_HMAC_MAX_SKEW_MS`
- `BREWVA_TELEGRAM_INGRESS_NONCE_TTL_MS`

Optional Telegram API endpoint override (useful for local e2e/fake API tests):

- `BREWVA_TELEGRAM_API_BASE_URL`

For the complete Worker + Fly webhook deployment path, see:
`docs/guide/telegram-webhook-edge-ingress.md`

To temporarily restore upstream version-check notifications (this is an upstream `pi-coding-agent` environment variable), launch with an empty override:

```bash
PI_SKIP_VERSION_CHECK= bun run start
```

## Typical Commands

```bash
bun run start
bun run start -- --print "Refactor runtime cost tracker"
bun run start -- --mode json "Summarize recent changes"
bun run start -- --print --task-file ./task.json
bun run start -- --undo --session <session-id>
bun run start -- --replay --mode json --session <session-id>
bun run start -- --version
bun run start -- onboard --install-daemon
bun run start -- --channel telegram --telegram-token <bot-token>
bun run start -- --channel tg --telegram-token <bot-token> --telegram-poll-timeout 15
BREWVA_TELEGRAM_WEBHOOK_ENABLED=1 BREWVA_TELEGRAM_INGRESS_HMAC_SECRET=<secret> bun run start -- --channel telegram --telegram-token <bot-token>
```

## Related Journey

- `docs/journeys/channel-gateway-and-turn-flow.md`
- `docs/guide/gateway-control-plane-daemon.md`
