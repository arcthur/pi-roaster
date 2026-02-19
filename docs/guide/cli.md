# CLI

CLI implementation: `packages/brewva-cli/src/index.ts`.

## Execution Modes

- Interactive mode (default)
- One-shot text mode (`--print`)
- One-shot JSON mode (`--mode json` or `--json`; newline-delimited JSON output, plus final `brewva_event_bundle`)
- Undo mode (`--undo`)
- Replay mode (`--replay`)

## Startup Behavior

- Interactive mode defaults to quiet startup, reducing banner/changelog/version-check noise during initialization.
- This behavior is enforced by `@brewva/brewva-cli` and does not depend on local `pi-coding-agent` configuration files.

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
- `--session`
- `--verbose`
- `--help`

Short aliases:

- `-p` for `--print`
- `-i` for `--interactive`
- `-h` for `--help`

`--verbose` overrides quiet startup and emits the full startup output.

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
```
