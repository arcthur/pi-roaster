# Documentation Index

This repository uses a layered documentation system:

- `guide`: how to use and operate the system
- `architecture`: implemented design, boundaries, and invariants
- `reference`: stable contracts and technical surfaces
- `journeys`: end-to-end workflows across subsystems
- `troubleshooting`: failure patterns and remediation
- `research`: incubating design notes with explicit promotion targets

## Getting Started

- Overview: `docs/guide/overview.md`
- Installation: `docs/guide/installation.md`
- Features: `docs/guide/features.md`
- CLI: `docs/guide/cli.md`
- Gateway daemon: `docs/guide/gateway-control-plane-daemon.md`
- Telegram webhook edge ingress: `docs/guide/telegram-webhook-edge-ingress.md`
- Runtime architecture: `docs/guide/understanding-runtime-system.md`
- Orchestration: `docs/guide/orchestration.md`
- Skill categories: `docs/guide/category-and-skills.md`

## Journeys

- Planning to execution: `docs/journeys/planning-to-execution.md`
- Channel gateway flow: `docs/journeys/channel-gateway-and-turn-flow.md`
- Context and compaction: `docs/journeys/context-and-compaction.md`
- Background and parallelism: `docs/journeys/background-and-parallelism.md`
- Intent-driven scheduling: `docs/journeys/intent-driven-scheduling.md`
- Session handoff and replay: `docs/journeys/session-handoff-and-reference.md`
- Operations and debugging: `docs/journeys/operations-and-debugging.md`

## Architecture

- System architecture: `docs/architecture/system-architecture.md`
- Control and data flow: `docs/architecture/control-and-data-flow.md`
- Invariants and reliability: `docs/architecture/invariants-and-reliability.md`

## Reference

- Configuration: `docs/reference/configuration.md`
- Tools: `docs/reference/tools.md`
- Skills: `docs/reference/skills.md`
- Runtime API: `docs/reference/runtime.md`
- Events: `docs/reference/events.md`
- Extensions: `docs/reference/extensions.md`
- Commands (CLI surface): `docs/reference/commands.md`
- Gateway control-plane protocol: `docs/reference/gateway-control-plane-protocol.md`
- Session lifecycle: `docs/reference/session-lifecycle.md`
- Artifacts and paths: `docs/reference/artifacts-and-paths.md`
- Glossary: `docs/reference/glossary.md`
- Known limitations: `docs/reference/limitations.md`

## Troubleshooting

- Troubleshooting: `docs/troubleshooting/common-failures.md`

## Research (Incubation Layer)

- Research playbook: `docs/research/README.md`
- Roadmap notes: `docs/research/roadmap-notes.md`

## Source of Truth

- Runtime package: `packages/brewva-runtime/src/index.ts`
- Telegram channel package: `packages/brewva-channels-telegram/src/index.ts`
- Telegram ingress package: `packages/brewva-ingress/src/index.ts`
- Tool package: `packages/brewva-tools/src/index.ts`
- Extension package: `packages/brewva-extensions/src/index.ts`
- CLI package: `packages/brewva-cli/src/index.ts`
- Gateway package: `packages/brewva-gateway/src/index.ts`
