# pi-roaster

AI-native coding agent runtime built on Bun + TypeScript + pi-mono coding-agent SDK.

## Packages

- `@pi-roaster/roaster-runtime`: skill contracts, selector, ledger, verification, parallel budget, security
- `@pi-roaster/roaster-tools`: custom tool definitions (ledger query, skill lifecycle, lsp/ast/look-at adapters)
- `@pi-roaster/roaster-extensions`: extension factories wiring runtime + tools into pi events
- `@pi-roaster/roaster-cli`: CLI and `createRoasterSession` bootstrap

## Quick Start

```bash
bun install
bun run build
bun run start -- --help
```

## Documentation

- Index: `docs/index.md`
- Guides: `docs/guide`
- Reference contracts: `docs/reference`
- Journeys: `docs/journeys`
- Troubleshooting: `docs/troubleshooting`

Run docs quality checks:

```bash
bun run test:docs
```

## CLI Modes

`pi-roaster` supports both interactive TUI and one-shot execution:

```bash
# interactive TUI
bun run start

# interactive TUI with initial prompt
bun run start -- "Fix failing tests in runtime"

# one-shot mode
bun run start -- --print "Refactor this function"
```

## Binary Distribution

Platform binaries are built with Bun compile and emitted into per-platform workspace packages:

```bash
bun run build:binaries
```

Distribution packages live under `distribution/*` (separate from runtime/tooling business packages).
The publishable launcher package is `@pi-roaster/pi-roaster`, which resolves and executes the matching platform package binary at install/runtime.
Installed command name for the launcher package is `pi-roaster`.
