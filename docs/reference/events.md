# Reference: Events

Event system sources:

- Persistent store: `packages/brewva-runtime/src/events/store.ts`
- Event pipeline/filtering: `packages/brewva-runtime/src/services/event-pipeline.ts`
- Runtime facade: `packages/brewva-runtime/src/runtime.ts`
- Extension bridge: `packages/brewva-extensions/src/event-stream.ts`

## Event Schemas

Core event contracts are defined in `packages/brewva-runtime/src/types.ts`:

- `BrewvaEventRecord`
- `BrewvaStructuredEvent`
- `BrewvaEventCategory`
- `BrewvaReplaySession`

## Emission Levels (`infrastructure.events.level`)

The runtime filters emitted events by level:

- `audit`
- `ops` (default)
- `debug`

### `audit`

Audit level keeps replay/audit-critical events only:

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- `tool_result_recorded`
- `verification_outcome_recorded`
- `verification_state_reset`
- `schedule_intent`
- `schedule_recovery_deferred`
- `schedule_recovery_summary`
- `schedule_wakeup`
- `schedule_child_session_started`
- `schedule_child_session_finished`
- `schedule_child_session_failed`

### `ops`

Ops level includes all audit events plus operational transitions and warnings (for example context pressure, budget alerts, channel lifecycle, etc.).

Common operational events include:

- `turn_wal_appended`
- `turn_wal_status_changed`
- `turn_wal_recovery_completed`
- `turn_wal_compacted`

### `debug`

Debug level includes the full stream, including high-noise diagnostics such as:

- `viewport_*`
- `cognitive_*`
- `tool_parallel_read`

Switching event level changes observability density, not runtime decision logic.

## Common Event Families

This list is intentionally non-exhaustive. Unknown event types/fields should be treated as forward-compatible.

### Session/Turn

- `session_start`
- `session_shutdown`
- `turn_start`
- `turn_end`

### Channel Gateway

- `channel_session_bound`
- `channel_turn_ingested`
- `channel_turn_dispatch_start`
- `channel_turn_dispatch_end`
- `channel_turn_emitted`
- `channel_turn_outbound_complete`
- `channel_turn_outbound_error`
- `channel_turn_bridge_error`

### Tool and Ledger

- `tool_call`
- `tool_result_recorded`
- `tool_parallel_read`
- `ledger_compacted`

`tool_result` itself is treated as an SDK hook boundary. Persisted semantic result records are emitted as `tool_result_recorded`.

### Task/Truth/Verification

- `task_event`
- `truth_event`
- `verification_state_reset`
- `verification_outcome_recorded`

### Context and Compaction

- `context_usage`
- `context_injected`
- `context_injection_dropped`
- `context_compaction_requested`
- `context_compaction_skipped`
- `context_compaction_gate_armed`
- `context_compaction_gate_blocked_tool`
- `context_compaction_gate_cleared`
- `critical_without_compact`
- `context_compacted`
- `session_compact_requested`
- `session_compact_request_failed`

### Memory and Cognitive

- `memory_unit_upserted`
- `memory_unit_superseded`
- `memory_crystal_compiled`
- `memory_working_published`
- `memory_insight_recorded`
- `memory_insight_dismissed`
- `memory_evolves_edge_reviewed`
- `memory_global_sync`
- `memory_global_recall`
- `cognitive_usage_recorded`
- `cognitive_relation_inference`
- `cognitive_relation_inference_skipped`
- `cognitive_relation_inference_failed`
- `cognitive_relevance_ranking`
- `cognitive_relevance_ranking_skipped`
- `cognitive_relevance_ranking_failed`
- `cognitive_outcome_reflection`
- `cognitive_outcome_reflection_skipped`
- `cognitive_outcome_reflection_failed`

Note: runtime API is async-first, but cognitive ranking can still emit `asyncResult` and skip metadata for internal non-applied ranking paths.

### Tape

- `anchor`
- `checkpoint`

### Schedule

- `schedule_intent`
- `schedule_recovery_deferred`
- `schedule_recovery_summary`
- `schedule_wakeup`
- `schedule_child_session_started`
- `schedule_child_session_finished`
- `schedule_child_session_failed`

### Turn WAL

- `turn_wal_appended`
- `turn_wal_status_changed`
- `turn_wal_recovery_completed`
- `turn_wal_compacted`

## Key Payload Notes

### `task_event`

Event-sourced task ledger stream (`brewva.task.ledger.v1`), including:

- `spec_set`
- `checkpoint_set`
- `status_set`
- `item_added`
- `item_updated`
- `blocker_recorded`
- `blocker_resolved`

### `truth_event`

Event-sourced truth ledger stream (`brewva.truth.ledger.v1`), including:

- `fact_upserted`
- `fact_resolved`

### `schedule_intent`

Primary schedule stream (`brewva.schedule.v1`) with `kind`:

- `intent_created`
- `intent_updated`
- `intent_cancelled`
- `intent_fired`
- `intent_converged`

Common fields include:

- `intentId`
- `parentSessionId`
- `reason`
- `continuityMode`
- `maxRuns`
- `runAt`
- `cron`
- `timeZone`
- `nextRunAt`
- `goalRef`
- `convergenceCondition`

### `verification_outcome_recorded`

Verification outcome summary (`brewva.verification.outcome.v1`) used by replay and memory learning loops.

### `memory_global_sync`

Global-memory lifecycle summary with counters and `globalSnapshotRef` pointer to persisted snapshot artifact.

### `tool_parallel_read`

Telemetry for runtime-aware multi-file read scans (mode, batch behavior, scanned/loaded/failed counts, limits).

### `turn_wal_status_changed`

Turn durability status transition summary, including:

- `scope`
- `walId`
- `turnId`
- `from`
- `to`
- `attempts`
- `error`

### `turn_wal_recovery_completed`

Startup recovery aggregate with totals and per-source counters:

- `scanned`
- `retried`
- `expired`
- `failed`
- `skipped`
- `compacted`
- `bySource`

### `viewport_*` and `cognitive_*`

These are debug diagnostics by default classification and are primarily intended for deep incident analysis.

## Replay and Query

Runtime query APIs:

- `runtime.events.query(sessionId, query?)`
- `runtime.events.queryStructured(sessionId, query?)`
- `runtime.events.listReplaySessions(limit?)`
- `runtime.events.subscribe(listener)`

Structured replay shape: `brewva.event.v1` (`BrewvaStructuredEvent`).
