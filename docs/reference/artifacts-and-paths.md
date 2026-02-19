# Reference: Artifacts And Paths

## Runtime Artifacts

- Evidence ledger: `.orchestrator/ledger/evidence.jsonl`
- Event stream: `.orchestrator/events/<session>.jsonl`
  - includes runtime and tool telemetry events such as `tool_parallel_read`
- Snapshot state: `.orchestrator/state/<session>.json`
- Rollback snapshots: `.orchestrator/snapshots/<session>/*.snap`
- Rollback patch history: `.orchestrator/snapshots/<session>/patchsets.json`
- Generated skill index: `.pi-roaster/skills_index.json`
  - includes selected skill roots (`roots`) and the merged selector index (`skills`)

## Distribution Paths

- Launcher package: `distribution/pi-roaster`
- Platform package examples:
  - `distribution/pi-roaster-darwin-arm64`
  - `distribution/pi-roaster-linux-x64`
  - `distribution/pi-roaster-windows-x64`

## Source Paths

- Runtime: `packages/roaster-runtime/src`
- Tools: `packages/roaster-tools/src`
- Extensions: `packages/roaster-extensions/src`
- CLI: `packages/roaster-cli/src`
