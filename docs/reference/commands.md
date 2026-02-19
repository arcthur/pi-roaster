# Reference: Commands (CLI Surface)

Brewva does not expose a slash-command registry. Its command surface is the CLI flag set.

Implementation source: `packages/brewva-cli/src/index.ts`.

## Mode Commands

- Interactive mode (default)
- Print text mode (`--print`)
- Print JSON mode (`--mode json`, `--json`; newline-delimited JSON output, plus final `brewva_event_bundle` for one-shot runs)
- Undo mode (`--undo`)
- Replay mode (`--replay`)

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
- `--session`
- `--verbose`
- `--help`

Short aliases:

- `-p` for `--print`
- `-i` for `--interactive`
- `-h` for `--help`

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
- Use `--verbose` to explicitly enable detailed startup output.
- To temporarily restore version-check notifications, run: `PI_SKIP_VERSION_CHECK= bun run start`.
