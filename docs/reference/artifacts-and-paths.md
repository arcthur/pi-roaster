# Reference: Artifacts And Paths

## Runtime Artifacts

Runtime artifact paths are resolved from the workspace root (`nearest .brewva/brewva.json` or `.git` ancestor), not the leaf execution subdirectory.

- Evidence ledger: `.orchestrator/ledger/evidence.jsonl`
- Event stream: `.orchestrator/events/<session>.jsonl`
  - includes runtime and tool telemetry events such as `tool_parallel_read`
- Memory units projection: `.orchestrator/memory/units.jsonl`
- Memory crystal projection: `.orchestrator/memory/crystals.jsonl`
- Memory insights projection: `.orchestrator/memory/insights.jsonl`
- Memory evolves shadow edges: `.orchestrator/memory/evolves.jsonl`
- Working memory markdown: `.orchestrator/memory/working.md`
- Memory projection state: `.orchestrator/memory/state.json`
- Memory refresh advisory lock (ephemeral): `.orchestrator/memory/.refresh.lock`
- Tape checkpoints: `checkpoint` events embedded in `.orchestrator/events/<session>.jsonl`
- Runtime recovery source: event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- Rollback snapshots: `.orchestrator/snapshots/<session>/*.snap`
  - per-file pre-mutation snapshots used only by rollback
- Rollback patch history: `.orchestrator/snapshots/<session>/patchsets.json`
- Generated skill index: `.brewva/skills_index.json`
  - includes selected skill roots (`roots`) and the merged selector index (`skills`)

## Global Roots

- Global Brewva root: `$XDG_CONFIG_HOME/brewva` (or `~/.config/brewva`)
  - resolution can be overridden via `BREWVA_CODING_AGENT_DIR` (see `packages/brewva-runtime/src/config/paths.ts`)
- Agent directory: `<globalRoot>/agent` (default: `~/.config/brewva/agent`)
  - authentication: `auth.json`
  - model registry: `models.json`

## Distribution Paths

- Launcher package: `distribution/brewva`
- Platform package examples:
  - `distribution/brewva-darwin-arm64`
  - `distribution/brewva-linux-x64`
  - `distribution/brewva-windows-x64`

## Source Paths

- Runtime: `packages/brewva-runtime/src`
- Tools: `packages/brewva-tools/src`
- Extensions: `packages/brewva-extensions/src`
- CLI: `packages/brewva-cli/src`
