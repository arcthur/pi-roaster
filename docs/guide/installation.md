# Installation

## Prerequisites

- Bun `1.3.9+`
- Node-compatible environment for CLI execution
- Model/provider setup supported by `@mariozechner/pi-coding-agent`

## Local Setup

```bash
bun install
bun run build
bun run start -- --help
```

## Validation Commands

```bash
bun run typecheck
bun test
bun run test:docs
```

## Key Configuration Paths

- Root scripts: `package.json`
- Workspace TS project graph: `tsconfig.json`
- Runtime defaults: `packages/brewva-runtime/src/config/defaults.ts`
