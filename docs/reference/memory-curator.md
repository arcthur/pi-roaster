# Reference: Memory Curator

Implementation entrypoint:

- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`

Supporting helpers:

- `packages/brewva-deliberation/src/cognition.ts`
- `packages/brewva-deliberation/src/proposals.ts`

## Role

`MemoryCurator` is the single control-plane entry point for cross-session
cognition rehydration.

It does not create kernel memory. It selects non-authoritative cognition
artifacts and re-enters them through the proposal boundary as `context_packet`
proposals.

## Current Strategies

Current built-in strategies:

- `reference match`
  - scan `.brewva/cognition/reference/`
  - select prompt-relevant artifacts by local BM25-style ranking and recency
  - submit evidence-backed `context_packet` proposals with TTL-bound packet keys
- `procedure match`
  - scan the same `.brewva/cognition/reference/` lane
  - detect `ProcedureNote` artifacts as a semantic subset of reference memory
  - rehydrate reusable verification-backed work patterns through dedicated
    `procedure:*` packet keys
- `episode resume`
  - scan `.brewva/cognition/summaries/`
  - detect `EpisodeNote` artifacts as a semantic subset of summary storage
  - require `session_scope` to match the target session before rehydration
  - rehydrate bounded process memory through dedicated `episode:*` packet keys
- `summary resume`
  - scan `.brewva/cognition/summaries/`
  - select prompt-relevant status summaries by local BM25-style ranking and
    recency
  - require `session_scope` to match the target session before rehydration
  - re-enter them through the same proposal/receipt path
- `open-loop resume`
  - scan recent `.brewva/cognition/summaries/` status summaries
  - on continuation-oriented prompts, select the most recent unresolved
    summary with a `next_action`, `blocked_on`, or unresolved status
  - require `session_scope` to match the target session before rehydration
  - this is a semantic filter over the `summaries` lane, not a third storage
    lane
  - rehydrate it as a scoped `context_packet` instead of mutating kernel state

Storage lane mapping:

- `reference` lane
  - may produce `reference:*` packets
  - may also produce `procedure:*` packets when the artifact parses as a
    `ProcedureNote`
- `summaries` lane
  - may produce `summary:*` packets
  - may also produce `episode:*` packets when the artifact parses as an
    `EpisodeNote`
  - may also produce `open-loop:*` packets when the artifact parses as an
    unresolved `StatusSummary`

Scope model:

- workspace-scoped cognition knowledge
  - `reference`
  - `procedure`
  - any session in the same workspace may rehydrate these when the query
    matches
- session-scoped process memory
  - `summary`
  - `episode`
  - `open_loop`
  - rehydration requires a matching `session_scope`
  - foreign session state is ignored even when the lexical query matches

Trigger-aware ranking:

- the curator may expand its query with control-plane wake-up metadata
- current wake-up sources may provide an `objective` and `contextHints`
- these hints improve retrieval quality without bypassing proposal admission

Current issuer:

- `brewva.extensions.memory-curator`

Current telemetry:

- `memory_reference_rehydrated`
- `memory_reference_rehydration_failed`
- `memory_procedure_rehydrated`
- `memory_procedure_rehydration_failed`
- `memory_summary_rehydrated`
- `memory_summary_rehydration_failed`
- `memory_episode_rehydrated`
- `memory_episode_rehydration_failed`
- `memory_open_loop_rehydrated`
- `memory_open_loop_rehydration_failed`
- `memory_adaptation_updated`
- `memory_adaptation_update_failed`

Current ranking feedback:

- the curator reads `.brewva/cognition/adaptation.json` before each
  `before_agent_start`
- packet-level and strategy-level usefulness observations may reorder
  reference/procedure/episode/summary candidates
- `open_loop` remains a continuation-first semantic path and is still pinned
  ahead of generic ranking when present
- packet-level bias is intentionally stronger than strategy-level bias because
  a concrete packet history is more predictive than a coarse strategy average

Current proactivity integration:

- wake-up triggers may provide `objective`, `contextHints`, and assembled wake
  context from `ProactivityEngine`
- the curator uses that wake context to improve BM25 retrieval without
  bypassing proposal admission
- wake-up retrieval still respects session scope for resumable summaries and
  episodes; a foreign session's unresolved state does not hydrate the target
  session
- skipped wake-ups do not run curator selection at all

## Boundary Rules

`MemoryCurator` may:

- read cognition artifacts
- rank/select artifacts outside the kernel
- submit `context_packet` proposals

`MemoryCurator` may not:

- mutate truth, task, ledger, or tape state directly
- bypass proposal receipts
- inject cognition artifacts implicitly

## Expansion Rule

Future strategies must still be added under the same curator entry point. The
goal is to avoid multiple independent rehydration hooks competing for the same
context budget with incompatible policies.

`MemoryCurator` is intentionally paired with `MemoryFormation`:

- `MemoryFormation` creates summaries, episodes, open loops, and procedural
  notes.
- `MemoryCurator` decides which of them should come back.
