# Reference: Memory Formation

Implementation entrypoint:

- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`

Supporting helpers:

- `packages/brewva-deliberation/src/cognition.ts`
- `packages/brewva-runtime/src/events/event-types.ts`

## Role

`MemoryFormation` is the write-side control-plane path for Brewva cognition
artifacts.

It does not create kernel memory. It persists non-authoritative status
summaries under `.brewva/cognition/summaries/` so later sessions can rehydrate
them through the proposal boundary.

It also persists verified procedural notes under `.brewva/cognition/reference/`
when replayable evidence shows a reusable work pattern.

It may also persist bounded `EpisodeNote` artifacts under
`.brewva/cognition/summaries/` when replayable process history is useful for
future resumption.

## Current Triggers

Current built-in triggers:

- `agent_end`
  - write a resumable turn/session summary when the semantic snapshot changed
- `session_compact`
  - write a compacted resumable summary before the next turn starts from the
    reduced message history
- `session_shutdown`
  - write the last resumable session snapshot before runtime state is cleared
- `skill_completed`, `blocker written/resolved`, and similar replayable
  process-state changes
  - contribute bounded evidence into `EpisodeNote` formation when a session
    boundary later persists an episode snapshot
- `verification_outcome_recorded`
  - when verification passes and emits a reusable recommendation, write a
    procedural note into the `reference/` lane

## Current Output Shape

Current output is a `status_summary` artifact with fields such as:

- `session_scope`
- `summary_kind`
- `status`
- `goal`
- `phase`
- `active_skill`
- `recent_skill`
- `recent_outputs`
- `next_action`
- `blocked_on`

These fields are non-authoritative. They are meant to help future sessions
resume work, not to replace task/truth/tape state.

`session_scope` is intentionally required for resumable `StatusSummary`
artifacts so that process memory does not bleed across unrelated live sessions
in the same workspace.

Current episodic output is an `EpisodeNote` artifact with fields such as:

- `session_scope`
- `episode_kind`
- `focus`
- `phase`
- `active_skill`
- `recent_skill`
- `recent_events`
- `next_action`
- `blocked_on`

Episodes are process memory, not truth. They preserve a bounded explanation of
how a line of work evolved so that later sessions can resume with more than a
single summary line.

The same `session_scope` rule applies to episodes: process-memory notes are
session-scoped even though they share the `summaries/` storage lane.

Current procedural output is a `ProcedureNote` artifact with fields such as:

- `note_kind`
- `lesson_key`
- `pattern`
- `recommendation`
- `verification_level`
- `active_skill`
- `failed_checks`
- `commands_executed`

These notes are still non-authoritative. They capture verified work patterns,
not kernel commitments.

## Formation Guidance

Write-side quality is influenced by control-plane adaptation guidance:

- low-signal summaries may be skipped when recent usefulness is poor
- low-signal episodes may require stronger evidence density before persisting
- low-value procedure notes may require a stable `lesson_key` or `pattern`

This guidance never changes kernel authority. It only affects what external
cognition sediment is worth persisting.

## Boundary Rules

`MemoryFormation` may:

- read runtime task/skill/tape status
- inspect recent replayable runtime events
- write cognition artifacts under `.brewva/cognition/summaries/`
- write cognition episodes under `.brewva/cognition/summaries/`
- emit observability events about summary persistence
- emit observability events about episode and procedure persistence

`MemoryFormation` may not:

- mutate truth, task, or ledger state directly
- auto-inject artifacts into model context
- bypass `MemoryCurator` or the proposal boundary

## Current Telemetry

- `memory_summary_written`
- `memory_summary_write_failed`
- `memory_episode_written`
- `memory_episode_write_failed`
- `memory_procedure_note_written`
- `memory_procedure_note_write_failed`

## Design Rule

Write-side cognition and read-side cognition stay separated:

- `MemoryFormation` decides what to persist.
- `MemoryFormation` also decides when a bounded episode is worth persisting.
- `MemoryCurator` decides what to rehydrate.
- the kernel still decides what may become visible through accepted
  `context_packet` proposals.
