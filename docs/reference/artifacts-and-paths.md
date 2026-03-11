# Reference: Artifacts And Paths

## Runtime Artifacts

Runtime artifact paths are resolved from the workspace root (`nearest .brewva/brewva.json` or `.git` ancestor), not the leaf execution subdirectory.

- Evidence ledger: `.orchestrator/ledger/evidence.jsonl`
- Event stream (event tape): `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`
  - file name uses a reversible base64url encoding of the UTF-8 `sessionId` to avoid filesystem collisions and preserve the original identifier
  - only `sess_*.jsonl` files are treated as event tape shards; non-prefixed JSONL files in the directory are ignored by the runtime
- includes runtime and tool telemetry events such as `tool_parallel_read`
- Projection units log: `.orchestrator/projection/units.jsonl`
- Working projection markdown: `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/working.md`
- Projection state: `.orchestrator/projection/state.json`
- Projection refresh advisory lock (ephemeral): `.orchestrator/projection/.refresh.lock`
- Debug-loop state: `.orchestrator/artifacts/sessions/sess_<base64url(sessionId)>/debug-loop.json`
  - `retryCount` records scheduled retries after the first failed implementation verification
- Debug-loop failure snapshot: `.orchestrator/artifacts/sessions/sess_<base64url(sessionId)>/failure-case.json`
- Deterministic handoff packet: `.orchestrator/artifacts/sessions/sess_<base64url(sessionId)>/handoff.json`
  - latest-wins snapshot; later `agent_end`, `session_shutdown`, or terminal debug-loop persistence overwrites the same file
- Tape checkpoints: `checkpoint` events embedded in the per-session event tape (`.orchestrator/events/sess_<base64url(sessionId)>.jsonl`)
- Runtime recovery source: event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- Rollback snapshots: `.orchestrator/snapshots/<session>/*.snap`
  - per-file pre-mutation snapshots used only by rollback
- Rollback patch history: `.orchestrator/snapshots/<session>/patchsets.json`
- Generated skill index: `.brewva/skills_index.json`
  - External broker traces: `.brewva/skill-broker/<sessionId>/*.json`
  - includes selected skill roots (`roots`) and the merged skill index (`skills`)
- Deliberation-side cognitive artifacts (non-kernel, not auto-injected): `.brewva/cognition/reference/` and `.brewva/cognition/summaries/`
  - these directories are operator/control-plane owned
  - runtime kernel does not read them implicitly; they must cross the boundary as `context_packet` proposals
  - helper surface: `packages/brewva-deliberation/src/cognition.ts`
  - debug-loop may publish scoped retry/handoff summaries here with a stable
    `packetKey=debug-loop:status`
  - terminal debug-loop handoff persistence may also publish
    `debug-loop-reference.md` under `reference/` for later cross-session
    rehydration
  - repeated packets can share a stable `packetKey` so the latest accepted
    cognition packet replaces earlier ones for injection without erasing tape history
  - `MemoryFormation` writes resumable `status_summary` artifacts here at
    lifecycle boundaries such as `agent_end`, `session_compact`, and
    `session_shutdown`
  - resumable `status_summary` and `EpisodeNote` artifacts carry a
    `session_scope` field so process memory stays tied to the target live
    session
  - `MemoryFormation` may also write bounded `EpisodeNote` artifacts under the
    same `summaries/` lane to preserve process memory without creating a new
    kernel-owned storage authority
  - `MemoryFormation` also writes verified `ProcedureNote` artifacts into the
    `reference/` lane when verification outcomes expose a reusable pattern and
    recommendation
  - operator teaching may append or supersede `ReferenceNote`,
    `ProcedureNote`, and `EpisodeNote` artifacts through the `cognition_note`
    operator tool
  - operator-teaching supersede remains append-only on disk, but retrieval and
    listing collapse older versions by semantic key
  - `registerMemoryCurator` may rehydrate selected `reference/` artifacts,
    prompt-matched `summaries/` artifacts, verification-backed procedural
    notes, and continuation-oriented open-loop summaries into accepted
    `context_packet` proposals for future sessions
  - control-plane ranking bias is persisted separately at
    `.brewva/cognition/adaptation.json`
  - that policy is owned by `registerMemoryAdaptation`; it does not define a
    new artifact lane and it never becomes kernel authority
  - storage lanes and retrieval strategies are intentionally not one-to-one:
    `reference` lane may yield `reference` or `procedure` hydration, and
    `summaries` lane may yield `summary`, `episode`, or `open_loop` hydration
- Agent identity profile (per-agent): `.brewva/agents/<agent-id>/identity.md`
  - `<agent-id>` comes from runtime option `agentId` (or `BREWVA_AGENT_ID`, fallback `default`)
  - id normalization: lowercase slug (`[a-z0-9._-]`, invalid separators mapped to `-`)
  - required section headings: `Who I Am`, `How I Work`, `What I Care About`
  - runtime renders those headings into the structured `[PersonaProfile]`
    context block; files without those headings are ignored

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
- Deliberation: `packages/brewva-deliberation/src`
- Tools: `packages/brewva-tools/src`
- Extensions: `packages/brewva-gateway/src/runtime-plugins`
- CLI: `packages/brewva-cli/src`
