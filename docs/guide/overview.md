# Overview

`pi-roaster` is an AI-native coding agent runtime built with Bun and TypeScript, organized as a monorepo with explicit package boundaries.

## Package Boundaries

- Runtime core: `packages/roaster-runtime/src/runtime.ts`
- Tool registry: `packages/roaster-tools/src/index.ts`
- Extension wiring: `packages/roaster-extensions/src/index.ts`
- CLI entrypoint: `packages/roaster-cli/src/index.ts`

## Runtime Responsibilities

- Skill discovery, ranking, activation, and contract enforcement
- Evidence ledger recording, digest generation, and query
- Verification gate evaluation and command-based verification checks
- Context budget planning and compaction signaling
- Event-first recovery via replayable runtime telemetry
- Structured event persistence and replay support
- Cost tracking with session and skill budget alerts

## Documentation Model

- `guide`: operational usage
- `reference`: contract-level definitions
- `journeys`: cross-module execution flows
- `troubleshooting`: incident-oriented remediation

Start from `docs/index.md` for the complete map.
