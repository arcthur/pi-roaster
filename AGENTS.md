# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-15T01:43:19Z  
**Commit:** a7789fb  
**Branch:** main

---

## OVERVIEW

`Brewva` is a Bun + TypeScript monorepo for an AI-native coding agent runtime built on top of `@mariozechner/pi-coding-agent`.

Primary deliverables:

- Runtime core (`@brewva/brewva-runtime`)
- Channel packages (`@brewva/brewva-channels-telegram`, …)
- Tool registry (`@brewva/brewva-tools`)
- Extension wiring (`@brewva/brewva-extensions`)
- CLI session bootstrap (`@brewva/brewva-cli`)
- Cross-platform compiled binaries (`distribution/*`)

---

## STRUCTURE

```text
brewva/
├── packages/
│   ├── brewva-runtime/            # skill contracts, ledger, verification, replay, snapshots, cost tracking
│   ├── brewva-channels-telegram/  # Telegram channel adapter, projector, transport
│   ├── brewva-tools/              # runtime-aware tools + lsp/ast helpers
│   ├── brewva-extensions/         # event hooks and runtime integration
│   └── brewva-cli/                # CLI entrypoint + session creation
├── distribution/             # launcher + per-platform binary packages
├── script/                   # build-binaries.ts, verify-dist.ts
├── skills/                   # base/packs/project skills
├── docs/                     # guides, reference, journeys, troubleshooting
└── test/                     # runtime/cli/extensions/docs coverage
```

---

## CRITICAL RULES

### 1) CLI Branding and Command Surface

- User-facing command name is `brewva`.
- `brewva` exists only as compatibility alias in `@brewva/brewva-cli`.
- Help text, examples, launcher package metadata, and process title must stay aligned with `brewva`.

### 2) Package Boundary and Import Policy

- Use workspace package imports across boundaries:
  - `@brewva/brewva-runtime`
  - `@brewva/brewva-tools`
  - `@brewva/brewva-extensions`
  - `@brewva/brewva-cli`
- Do not reintroduce local alias schemes like `@/...`.
- Do not mix `src` and `dist` class types in public boundaries (prevents nominal/private-field type conflicts).

### 3) Typecheck Coverage Must Include Build Scripts

- `script/build-binaries.ts` and `script/verify-dist.ts` are included through `script/tsconfig.json` and root project references.
- If you add scripts under `script/`, ensure they are covered by `tsc -b`.

### 4) Dist Safety Gate Is Mandatory

- `bun run test:dist` is the release guardrail:
  - verifies CLI dist help banner
  - verifies package resolution/import goes through `dist` under Node
- Do not bypass this when changing package exports, CLI entrypoints, or publishing paths.

### 5) Bun Is the Build/Test Runtime

- Use Bun for workspace commands (`bun run`, `bun test`, `bun build`).
- CI uses `oven-sh/setup-bun@v2` with Bun `1.3.9`.

---

## WHERE TO LOOK

| Task                  | Location                                  | Notes                                                |
| --------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Runtime behavior      | `packages/brewva-runtime/src/runtime.ts`  | orchestration state, verification, snapshots, replay |
| Runtime contracts     | `packages/brewva-runtime/src/types.ts`    | core shared types                                    |
| Tool registry         | `packages/brewva-tools/src/index.ts`      | all registered tools                                 |
| Extension composition | `packages/brewva-extensions/src/index.ts` | hook wiring and runtime/tool registration            |
| CLI args/modes        | `packages/brewva-cli/src/index.ts`        | parseArgs, interactive/print/json, undo/replay       |
| Session bootstrap     | `packages/brewva-cli/src/session.ts`      | model/session/resource loader setup                  |
| Binary build          | `script/build-binaries.ts`                | compile targets + runtime asset copy                 |
| Dist smoke checks     | `script/verify-dist.ts`                   | Node/dist import + help banner checks                |
| Launcher package      | `distribution/brewva/`                    | postinstall and platform resolution                  |
| CI pipeline           | `.github/workflows/ci.yml`                | quality + binaries jobs                              |

---

## CONVENTIONS

- Package manager: Bun (`packageManager: bun@1.3.9`).
- Node.js: `^20.19.0 || >=22.12.0` (required for oxc toolchain, launcher scripts, and `bun run test:dist`).
- Module system: ESM (`type: module`).
- TypeScript: strict mode, NodeNext, ES2023 target.
- Build graph:
  - root `tsconfig.json` references `packages/*` and `script/`.
  - `test/tsconfig.json` references package projects.
- Package exports pattern:
  - `bun` condition points to `src` for local Bun workflows.
  - `import/default` points to `dist` for published consumption.
- Keep public APIs explicit and typed; avoid `any` at boundaries.

---

## ANTI-PATTERNS (THIS REPO)

| Category        | Avoid                                                      |
| --------------- | ---------------------------------------------------------- |
| Imports         | `../../packages/...` cross-package imports                 |
| Aliases         | Reintroducing `@/...` + `baseUrl` path alias model         |
| Typing          | `src`/`dist` mixed class types in one boundary             |
| Type safety     | `as any`, `@ts-ignore`, `@ts-expect-error` as quick fixes  |
| Dist flow       | Editing generated distribution artifacts by hand           |
| Release safety  | Skipping `test:dist` after export/CLI/distribution changes |
| Package manager | npm/yarn workflows in this repository                      |

---

## COMMANDS

```bash
bun install
bun run typecheck
bun run typecheck:test
bun test
bun run test:docs
bun run test:dist
bun run build:binaries
bun run build
```

---

## CI PIPELINE

Workflow: `.github/workflows/ci.yml`

### quality job

1. install (`bun install --frozen-lockfile`)
2. `bun run typecheck`
3. `bun run typecheck:test`
4. `bun test`
5. `bun run test:docs`
6. `bun run test:dist`

### binaries job

1. `bun run build:binaries`
2. smoke test: `./distribution/brewva-linux-x64/bin/brewva --help`

---

## DEFINITION OF DONE (FOR CODE CHANGES)

Before finalizing:

1. `bun run typecheck` passes.
2. `bun run typecheck:test` passes.
3. `bun test` passes.
4. If exports/CLI/distribution changed: `bun run test:dist` passes.
5. If binary packaging changed: `bun run build:binaries` succeeds.
6. User-facing command/help text remains `brewva`-consistent.
