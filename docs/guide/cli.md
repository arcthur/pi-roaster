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

## Startup Behavior

- Interactive mode defaults to quiet startup, reducing banner/changelog/version-check noise during initialization.
- Startup UI behavior is controlled by `BrewvaConfig.ui` (`ui.quietStartup`, `ui.collapseChangelog`) and applied by `@brewva/brewva-cli`.

## Mode and Input Resolution

- `--task` and `--task-file` are mutually exclusive.
- If both TaskSpec and prompt text are provided, prompt text overrides `TaskSpec.goal`.
- When stdin/stdout is not a TTY and no explicit mode is selected, CLI falls back to text print mode.
- Explicit `--interactive` requires a TTY terminal and exits with an error otherwise.
- `--replay`/`--undo` default to auto-resolved sessions when `--session` is omitted.

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

`--no-extensions` disables presentation-oriented extension stack. CLI still
installs runtime core bridge hooks, so tool policy, compaction gate, and
ledger/patch tracking remain enforced.

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
bun run start -- --channel telegram --telegram-token <bot-token>
bun run start -- --channel tg --telegram-token <bot-token> --telegram-poll-timeout 15
```

## Related Journey

- `docs/journeys/channel-gateway-and-turn-flow.md`
