# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-23T22:05:00Z  
**Commit:** 5f3be8e  
**Branch:** main

---

## OVERVIEW

`Brewva` is a Bun + TypeScript monorepo for an AI-native coding-agent runtime
built on top of `@mariozechner/pi-coding-agent`.

Primary deliverables:

- Runtime core (`@brewva/brewva-runtime`)
- Channel adapter package (`@brewva/brewva-channels-telegram`)
- Tool registry (`@brewva/brewva-tools`)
- Extension composition (`@brewva/brewva-extensions`)
- CLI entrypoint/session bootstrap (`@brewva/brewva-cli`)
- Gateway daemon/control plane (`@brewva/brewva-gateway`)
- Cross-platform launcher binaries (`distribution/*`)

---

## STRUCTURE

```text
brewva/
├── packages/
│   ├── brewva-runtime/            # runtime facade, services, replay, memory, schedule, policy
│   ├── brewva-channels-telegram/  # telegram adapter, transport, projector
│   ├── brewva-tools/              # runtime-aware tools (lsp/ast/ledger/task/schedule/tape)
│   ├── brewva-extensions/         # SDK hook wiring for runtime integration
│   ├── brewva-cli/                # CLI modes, session wiring, replay/undo, daemon command surface
│   └── brewva-gateway/            # local control-plane daemon and session supervisor
├── distribution/                  # launcher + per-platform binary packages
├── script/                        # build-binaries.ts, verify-dist.ts, schema generator
├── docs/                          # architecture / guide / journeys / reference
├── skills/                        # base / packs / project skills
└── test/                          # runtime / cli / extensions / gateway / docs coverage
```

---

## CRITICAL RULES

### 1) CLI Branding and Command Surface

- User-facing command is `brewva`.
- Help text/examples/process title/launcher metadata must stay aligned with `brewva`.
- Dist smoke check must continue validating the `brewva` CLI help banner.

### 2) Workspace Boundary and Import Policy

- Use workspace package imports across package boundaries:
  - `@brewva/brewva-runtime`
  - `@brewva/brewva-runtime/channels`
  - `@brewva/brewva-tools`
  - `@brewva/brewva-extensions`
  - `@brewva/brewva-cli`
  - `@brewva/brewva-gateway`
- Do not reintroduce local alias schemes (for example `@/...`).
- Do not mix `src` and `dist` class types at public boundaries.

### 3) Runtime Public API Model (Current)

- `BrewvaRuntime` is domain-based, not a flat method bag.
- Public surface is organized as:
  - `runtime.skills.*`
  - `runtime.context.*`
  - `runtime.tools.*`
  - `runtime.task.*`
  - `runtime.truth.*`
  - `runtime.memory.*`
  - `runtime.schedule.*`
  - `runtime.turnWal.*`
  - `runtime.events.*`
  - `runtime.verification.*`
  - `runtime.cost.*`
  - `runtime.session.*`
- Integration direction is async-first; avoid introducing parallel sync facade APIs.

### 4) Runtime Semantics Baseline (Current)

- Security policy is strategy-based:
  - `security.mode: permissive | standard | strict`
  - `security.sanitizeContext: boolean`
- Event stream is level-based:
  - `infrastructure.events.level: audit | ops | debug` (default `ops`)
- Default context injection semantics are five sources:
  - `brewva.identity`
  - `brewva.truth`
  - `brewva.task-state`
  - `brewva.tool-failures`
  - `brewva.memory`
- Turn durability/recovery is WAL-based through `runtime.turnWal.*` and
  `infrastructure.turnWal.*` configuration.
- Internal tuning knobs removed from public config should stay internal unless they
  represent a clear user-facing decision boundary.

### 5) Typecheck and Script Coverage

- Root `tsconfig.json` project references include `packages/*` and `script/`.
- Build scripts under `script/` must remain covered by `tsc -b`.

### 6) Dist Safety Gate Is Mandatory

- `bun run test:dist` is the release guardrail:
  - verifies CLI help behavior in dist artifacts
  - verifies package resolution/import through `dist` under Node
- Do not skip `test:dist` for export surface / CLI / distribution changes.

### 7) Bun Is the Build/Test Runtime

- Use Bun commands for workspace workflows (`bun run`, `bun test`, `bun build`).
- CI setup is Bun `1.3.9` (`oven-sh/setup-bun@v2`).

---

## WHERE TO LOOK

| Task                         | Location                                                 | Notes                                           |
| ---------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Runtime facade/API shape     | `packages/brewva-runtime/src/runtime.ts`                 | domain API surface and dependency wiring        |
| Runtime contracts            | `packages/brewva-runtime/src/types.ts`                   | shared config/event/runtime types               |
| Runtime event filtering      | `packages/brewva-runtime/src/services/event-pipeline.ts` | audit/ops/debug level classification            |
| Security mode mapping        | `packages/brewva-runtime/src/security/mode.ts`           | `security.mode` -> effective enforcement policy |
| Runtime defaults             | `packages/brewva-runtime/src/config/defaults.ts`         | canonical default config profile                |
| Runtime config normalization | `packages/brewva-runtime/src/config/normalize.ts`        | type/enum/range normalization                   |
| Turn WAL durability/recovery | `packages/brewva-runtime/src/channels/turn-wal*.ts`      | append/recover/compact turn WAL rows            |
| Tool registry                | `packages/brewva-tools/src/index.ts`                     | assembled tool surface                          |
| Extension composition        | `packages/brewva-extensions/src/index.ts`                | runtime hook wiring and bridge helpers          |
| CLI command surface          | `packages/brewva-cli/src/index.ts`                       | mode routing, args, entrypoint behavior         |
| CLI session bootstrap        | `packages/brewva-cli/src/session.ts`                     | runtime/session creation and options            |
| Gateway daemon core          | `packages/brewva-gateway/src`                            | websocket API, supervisor, policies             |
| Dist verification            | `script/verify-dist.ts`                                  | release guardrail checks                        |
| Binary build                 | `script/build-binaries.ts`                               | platform binaries and launcher copy             |
| CI workflow                  | `.github/workflows/ci.yml`                               | quality + binaries jobs                         |

---

## CONVENTIONS

- Package manager: Bun (`packageManager: bun@1.3.9`).
- Node.js: `^20.19.0 || >=22.12.0`.
- Module system: ESM (`type: module`).
- TypeScript: strict mode, NodeNext, ES2023 target.
- Root quality command: `bun run check` (`format:check + lint + typecheck + typecheck:test`).
- Package export pattern:
  - `bun` condition points to `src` for local Bun workflows
  - `import/default` points to `dist` for published consumption

---

## ANTI-PATTERNS (THIS REPO)

| Category        | Avoid                                                       |
| --------------- | ----------------------------------------------------------- |
| Imports         | `../../packages/...` cross-package imports                  |
| Aliases         | reintroducing `@/...` / `baseUrl` alias model               |
| Typing          | mixing `src`/`dist` class types across boundaries           |
| Type safety     | `as any`, `@ts-ignore`, `@ts-expect-error` quick fixes      |
| Runtime API     | adding new flat runtime methods instead of domain APIs      |
| Config surface  | re-exposing removed low-level tuning knobs as public fields |
| Dist flow       | editing generated distribution artifacts by hand            |
| Release safety  | skipping `bun run test:dist` for export/CLI/dist changes    |
| Package manager | npm/yarn workflows in this repository                       |

---

## COMMANDS

```bash
bun install
bun run check
bun run typecheck
bun run typecheck:test
bun test
bun run test:docs
bun run test:dist
bun run build:binaries
bun run build
```

Useful extended checks:

```bash
bun run lint
bun run format:check
bun run test:e2e
bun run test:e2e:live
```

---

## CI PIPELINE

Workflow: `.github/workflows/ci.yml`

### quality job

1. `bun install --frozen-lockfile`
2. `bun run check`
3. `bun test`
4. `bun run test:docs`
5. `bun run test:dist`

### binaries job

1. `bun install --frozen-lockfile`
2. `bun run build:binaries`
3. Linux smoke: `./distribution/brewva-linux-x64/bin/brewva --help | head -n 1`

---

## DEFINITION OF DONE (FOR CODE CHANGES)

Before finalizing:

1. `bun run typecheck` passes.
2. `bun run typecheck:test` passes.
3. `bun test` passes.
4. `bun run test:docs` passes for docs/config/runtime-reference edits.
5. `bun run test:dist` passes for export/CLI/distribution surface edits.
6. `bun run build:binaries` succeeds when packaging/launcher behavior changes.
7. User-facing command/help text remains `brewva`-consistent.

---

## RELATED REFERENCE DOCS

- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/reference/events.md`
- `docs/reference/extensions.md`
- `docs/reference/limitations.md`
