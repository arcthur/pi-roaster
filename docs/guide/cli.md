# CLI

CLI implementation: `packages/roaster-cli/src/index.ts`.

## Execution Modes

- Interactive mode (default)
- One-shot text mode (`--print`)
- One-shot JSON mode (`--mode json` or `--json`)
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

## Typical Commands

```bash
bun run start
bun run start -- --print "Refactor runtime cost tracker"
bun run start -- --mode json "Summarize recent changes"
bun run start -- --print --task-file ./task.json
bun run start -- --undo --session <session-id>
bun run start -- --replay --mode json --session <session-id>
```
