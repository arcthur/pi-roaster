# Brewva

<p align="center">
  <a href="https://github.com/arcthur/brewva/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/arcthur/brewva/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/arcthur/brewva/releases"><img src="https://img.shields.io/github/v/release/arcthur/brewva?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache-blue.svg?style=for-the-badge" alt="Apache License"></a>
</p>

Brewva is an AI-native coding-agent runtime built with Bun and TypeScript. It keeps agent execution explicit, evented, and recoverable: intelligence can propose, but the runtime decides what becomes a durable system commitment.

**Intelligence proposes. Kernel commits. Tape remembers.**

## What Brewva Optimizes For

- Deterministic runtime boundaries for context, tools, verification, cost, and state mutation
- Tape-first durability and replay, with working state rebuilt from event history
- Explicit proposal and governance boundaries instead of implicit agent-side mutation
- Bounded autonomy through policy-driven execution, context pressure controls, and failure handling
- Extensible operator surfaces through CLI, gateway, extensions, channel adapters, and ingress packages

The runtime is optimized around one question:

`Why can we trust this agent action?`

## Architecture

```mermaid
flowchart TD
  AGENT["Agent (LLM)"]
  BOUNDARY["Boundary Layer<br/>Tool Gate + Cost Gate + Context Compaction"]
  CONTRACT["Contract Layer<br/>Proposals + Task/Truth + Verification"]
  DURABILITY["Durability Layer<br/>Event Tape + Replay + Turn WAL"]
  PROJECTION["Working Projection<br/>units.jsonl + working.md"]
  OPERATORS["Operator Surfaces<br/>CLI + Gateway + Extensions + Channels"]

  AGENT --> BOUNDARY
  BOUNDARY --> CONTRACT
  CONTRACT --> DURABILITY
  DURABILITY --> PROJECTION
  OPERATORS --> BOUNDARY
  OPERATORS --> DURABILITY
```

Implementation detail and system boundaries:

- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/control-and-data-flow.md`
- `docs/reference/proposal-boundary.md`
- `docs/journeys/working-projection.md`

## Package Surfaces

- `@brewva/brewva-runtime`: runtime contracts, replay, projection, verification, governance, cost, and WAL durability
- `@brewva/brewva-deliberation`: proposal producers, evidence helpers, and control-plane planning helpers
- `@brewva/brewva-skill-broker`: broker-backed skill selection and control-plane integration
- `@brewva/brewva-tools`: runtime-aware tools for code, tape, task, schedule, observability, and skill control flows
- `@brewva/brewva-extensions`: runtime hook wiring, integration guards, and debug-loop orchestration
- `@brewva/brewva-cli`: interactive CLI, print/json modes, replay/undo, daemon, and channel entrypoints
- `@brewva/brewva-gateway`: local control-plane daemon and worker supervision
- `@brewva/brewva-channels-telegram`: Telegram adapter and transport
- `@brewva/brewva-ingress`: webhook worker/server ingress for Telegram edge delivery
- `distribution/brewva` and `distribution/brewva-*`: launcher and per-platform binary packages
- `distribution/worker`: edge deployment templates for webhook ingress

## Skill Surface

- Core skills: `repository-analysis`, `design`, `implementation`, `debugging`, `review`
- Domain skills: `agent-browser`, `frontend-design`, `github`, `goal-loop`, `structured-extraction`, `telegram`
- Operator skills: `git-ops`, `runtime-forensics`
- Meta skills: `self-improve`, `skill-authoring`

For taxonomy details and project overlays, see `docs/guide/features.md` and `docs/reference/skills.md`.

## Quick Start

### Repository Mode

```bash
bun install
bun run build
bun run start -- --help
bun run start
```

### Local `brewva` Command

```bash
bun run install:local
brewva --help
brewva "Summarize recent runtime changes"
```

The local installer targets macOS and Linux and can build missing binaries automatically.

For complete installation, CLI, daemon, and channel setup guidance:

- `docs/guide/installation.md`
- `docs/guide/cli.md`
- `docs/guide/gateway-control-plane-daemon.md`
- `docs/guide/telegram-webhook-edge-ingress.md`

## Development

```bash
bun run check
bun test
bun run test:docs
bun run test:dist
bun run build:binaries
```

Useful additional commands:

```bash
bun run analyze:projection
bun run test:e2e
bun run test:e2e:live
```

## Documentation Map

| Section         | Path                    | Purpose                                                                 |
| --------------- | ----------------------- | ----------------------------------------------------------------------- |
| Guides          | `docs/guide/`           | Installation, operation, feature walkthroughs, and usage flows          |
| Architecture    | `docs/architecture/`    | Implemented design, invariants, and control/data boundaries             |
| Journeys        | `docs/journeys/`        | End-to-end flows across runtime, gateway, channels, and orchestration   |
| Reference       | `docs/reference/`       | Stable contracts for config, runtime API, tools, events, and extensions |
| Troubleshooting | `docs/troubleshooting/` | Failure patterns and remediation                                        |
| Research        | `docs/research/`        | Incubating design notes and roadmap material                            |

Start from `docs/index.md` for the full documentation map.

## Related Guides

- `docs/guide/overview.md`
- `docs/guide/features.md`
- `docs/guide/orchestration.md`
- `docs/guide/understanding-runtime-system.md`
- `docs/reference/commands.md`

## Inspired By

- [Amp](https://ampcode.com/)
- [bub](https://bub.build/)
- [openclaw](https://openclaw.ai/)

## License

[Apache](LICENSE)
