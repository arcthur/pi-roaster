# Brewva Agent Guide

## Purpose

- This file is the repository-specific operating guide for agents working in `brewva/`.
- Keep it short, current, and action-oriented. If the repo state and this guide diverge, update this guide in the same change or call out the drift explicitly.
- Use it as a map, not as the full source of truth. Long-form design detail belongs in `docs/**`; code and tests remain authoritative.
- Priority order: `Hard Invariants` -> `Workflow Gates` -> `Verification` -> `Where to Look`.

## Repo At A Glance

- `Brewva` is a Bun + TypeScript monorepo for an AI-native coding-agent runtime built on `@mariozechner/pi-coding-agent`.
- Workspace packages live under `packages/*`; the primary surfaces are `runtime`, `deliberation`, `skill-broker`, `channels-telegram`, `ingress`, `tools`, `extensions`, `cli`, and `gateway`.
- Distribution surfaces live under `distribution/brewva`, `distribution/brewva-*`, and `distribution/worker`.
- Support roots: `script/` for build and verification, `docs/` for design/reference material, and `test/` for workspace coverage.

## Hard Invariants

### Branding and Packaging

- The user-facing command is `brewva`.
- Help text, examples, process titles, launcher metadata, and packaging output must stay aligned with `brewva`.
- Dist smoke checks must continue validating the `brewva` help banner.

### Workspace Boundaries

- Use workspace package imports across package boundaries. Allowed public imports are `@brewva/brewva-runtime`, `@brewva/brewva-runtime/channels`, `@brewva/brewva-deliberation`, `@brewva/brewva-skill-broker`, `@brewva/brewva-channels-telegram`, `@brewva/brewva-ingress`, `@brewva/brewva-tools`, `@brewva/brewva-addons`, `@brewva/brewva-cli`, and `@brewva/brewva-gateway`.
- Do not reintroduce local alias schemes such as `@/...`.
- Do not mix `src` and `dist` class types at public boundaries.
- Do not import from `distribution/**` packages inside workspace package code; treat them as release artifacts.

### Runtime Contract

- `BrewvaRuntime` stays domain-based, not a flat method bag. Keep the public API organized under the existing runtime domains in `packages/brewva-runtime/src/runtime.ts`.
- Current runtime domain groups are `runtime.skills.*`, `runtime.proposals.*`, `runtime.context.*`, `runtime.tools.*`, `runtime.task.*`, `runtime.truth.*`, `runtime.ledger.*`, `runtime.schedule.*`, `runtime.turnWal.*`, `runtime.events.*`, `runtime.verification.*`, `runtime.cost.*`, and `runtime.session.*`.
- Integration direction is async-first; do not add parallel sync facade APIs.
- Preserve the current security, event-level, and fail-fast config semantics described in `packages/brewva-runtime/src/types.ts`, `packages/brewva-runtime/src/security/mode.ts`, and `docs/reference/configuration.md`.
- Preserve the current runtime execution shape: shared invocation spine first, then posture policy (`observe`, `reversible_mutate`, `commitment`), then receipt-bearing effect authorization or rollback.
- Preserve the current context model: deterministic single-path injection, explicit context source labels, working-only projection, deterministic `skill_routing_selection` telemetry, and WAL-based turn durability/recovery.
- Keep `governancePort` governance-only and do not re-expose removed internal tuning knobs unless they represent a clear user-facing decision boundary.
- Keep commitment flows replay-first: `effect_commitment` proposals, operator-desk approval events, and explicit resume via `effectCommitmentRequestId` are the source of truth, not process-local approval state.
- Keep reversible mutation flows receipt-based: `reversible_mutate` must continue producing rollback/journal artifacts and remain recoverable through `runtime.tools.rollbackLastMutation(...)`.

### Build Baseline

- Build and test with Bun, not npm or yarn. Baseline is Bun `1.3.9`, Node `^20.19.0 || >=22.12.0`, ESM, strict TypeScript, and a root `tsconfig.json` that continues covering `packages/*` and `script/`.

## Workflow Gates

- If a task matches multiple gates, run the union of required checks.
- If a named helper workflow is unavailable, do the equivalent manual steps and report that fallback.
- Helper workflows:
  - `$implementation-strategy`: record compatibility boundary, migration or rollback posture, affected public or persisted surfaces, and validation scope before editing
  - `$exec-plan`: keep a short milestone plan with statuses
  - `$code-change-verification`: `bun run check && bun test`
  - `$docs-verification`: `bun run test:docs` plus `bun run format:docs:check` when Markdown formatting changed
  - `$dist-safety-gate`: `bun run test:dist`
  - `$binary-packaging-verification`: `bun run build:binaries` plus a built `brewva --help` smoke test
  - `$pi-docs-sync`: read relevant Pi docs and linked references first
- Mandatory triggers:
  - Runtime public APIs, exported package surfaces, config schema or default semantics, persisted formats, WAL recovery semantics, wire protocols, or user-facing CLI behavior: run `$implementation-strategy` before writing code
  - Multi-step, cross-package, refactor-heavy, or long-running work: maintain `$exec-plan`
  - Changes under `packages/**`, `test/**`, `script/**`, `package.json`, `tsconfig*.json`, `bunfig.toml`, or `.github/workflows/**`: run `$code-change-verification`
  - Changes under `docs/**`, `README.md`, or `test/docs/**`: run `$docs-verification`
  - Changes to exports, CLI, or distribution surfaces, including `packages/brewva-cli/**`, `distribution/**`, `script/verify-dist.ts`, or package export maps: run `$dist-safety-gate`
  - Changes to launcher or binary packaging behavior, including `script/build-binaries.ts` or `distribution/**` packaging metadata: run `$binary-packaging-verification`
  - Pi-specific tasks covering SDK, extensions, themes, skills, prompt templates, TUI, keybindings, providers, models, or packages: run `$pi-docs-sync` first
  - Pure meta-guidance edits such as `AGENTS.md` or skill docs with no code, config, or runtime impact may skip code and docs verification unless explicitly requested

## Verification

- Default quality stack: `bun run check` and `bun test`.
- Docs stack: `bun run test:docs`; add `bun run format:docs:check` for Markdown formatting changes, including `README.md`.
- Dist safety gate: `bun run test:dist`.
- Binary packaging verification: `bun run build:binaries` and smoke `./distribution/brewva-linux-x64/bin/brewva --help | head -n 1`.
- Release-facing changes must keep the command/help surface `brewva`-consistent.

## Where To Look

- Runtime API and contracts: `packages/brewva-runtime/src/runtime.ts`, `packages/brewva-runtime/src/types.ts`
- Runtime config and semantics: `packages/brewva-runtime/src/config/defaults.ts`, `packages/brewva-runtime/src/config/normalize.ts`, `packages/brewva-runtime/src/security/mode.ts`, `packages/brewva-runtime/src/services/event-pipeline.ts`
- Runtime context and durability: `packages/brewva-runtime/src/context/arena.ts`, `packages/brewva-runtime/src/context/injection-orchestrator.ts`, `packages/brewva-runtime/src/services/context*.ts`, `packages/brewva-runtime/src/channels/turn-wal*.ts`, `packages/brewva-runtime/src/governance/port.ts`
- Runtime posture / authorization / rollback: `packages/brewva-runtime/src/services/tool-gate.ts`, `packages/brewva-runtime/src/services/effect-commitment-desk.ts`, `packages/brewva-runtime/src/services/reversible-mutation.ts`, `packages/brewva-runtime/src/services/mutation-rollback.ts`, `packages/brewva-runtime/src/services/exploration-supervisor.ts`, `packages/brewva-runtime/src/services/task-watchdog-service.ts`
- Package entrypoints: `packages/brewva-deliberation/src/index.ts`, `packages/brewva-skill-broker/src/index.ts`, `packages/brewva-tools/src/index.ts`, `packages/brewva-gateway/src/runtime-plugins/index.ts`, `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts`, `packages/brewva-gateway/src/channels/host.ts`, `packages/brewva-gateway/src/host/create-hosted-session.ts`, `packages/brewva-ingress/src/index.ts`, `packages/brewva-cli/src/index.ts`, `packages/brewva-gateway/src`
- Verification and release tooling: `script/verify-dist.ts`, `script/build-binaries.ts`, `distribution/worker`, `.github/workflows/ci.yml`
- Reference docs: `docs/index.md`, `docs/architecture/system-architecture.md`, `docs/reference/runtime.md`, `docs/reference/proposal-boundary.md`, `docs/reference/events.md`, `docs/reference/*.md`, `docs/research/README.md`

## Anti-Patterns

- Cross-package relative imports such as `../../packages/...`
- Reintroducing alias-based import models
- `as any`, `@ts-ignore`, or `@ts-expect-error` quick fixes
- Adding new flat runtime methods instead of extending domain APIs
- Re-exposing removed low-level tuning knobs as public config
- Editing generated distribution artifacts by hand
- Skipping `test:dist` for export, CLI, or distribution changes
