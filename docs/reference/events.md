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
- `exec_routed`
- `exec_fallback_host`
- `exec_blocked_isolation`
- `exec_sandbox_error`

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
- `channel_command_received`
- `channel_command_rejected`
- `channel_agent_created`
- `channel_agent_deleted`
- `channel_focus_changed`
- `channel_fanout_started`
- `channel_fanout_finished`
- `channel_discussion_round`
- `channel_a2a_invoked`
- `channel_a2a_blocked`
- `channel_approval_routing_persisted`
- `channel_approval_state_persisted`
- `channel_workspace_cost_summary`

### Tool and Ledger

- `tool_call`
- `tool_result_recorded`
- `tool_parallel_read`
- `ledger_compacted`
- `exec_routed`
- `exec_fallback_host`
- `exec_blocked_isolation`
- `exec_sandbox_error`

`tool_result` itself is treated as an SDK hook boundary. Persisted semantic result records are emitted as `tool_result_recorded`.

### Task/Truth/Verification

- `task_event`
- `truth_event`
- `verification_state_reset`
- `verification_outcome_recorded`

### Context and Compaction

- `context_usage`
- `context_injected`
- `context_arena_zone_adapted`
- `context_arena_slo_enforced`
- `context_arena_floor_unmet_recovered`
- `context_arena_floor_unmet_unrecoverable`
- `context_stability_monitor_tripped`
- `context_stability_monitor_reset`
- `context_strategy_selected`
- `context_evolution_feature_disabled`
- `context_evolution_feature_reenabled`
- `context_injection_dropped`
- `context_external_recall_skipped`
- `context_external_recall_injected`
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
- `memory_recall_query_expanded`
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

### `checkpoint`

Tape checkpoint payload (`brewva.tape.checkpoint.v1`) includes:

- `state.task`
- `state.truth`
- `state.cost`
- `state.costSkillLastTurnByName`
- `state.evidence`
- `state.memory`
- `basedOnEventId`
- `latestAnchorEventId`
- `reason`
- `createdAt`

`state.costSkillLastTurnByName` persists per-skill last seen turn metadata used
by replay/hydration to keep `summary.skills[*].turns` deduplicated by turn after
checkpoint restore.

Legacy checkpoints that do not carry `state.cost`, `state.costSkillLastTurnByName`,
`state.evidence`, or `state.memory` are accepted with empty defaults for those
slices.

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

### `context_injected` and `context_injection_dropped`

Context planner telemetry summary. Common payload fields include:

- `zoneDemandTokens`
- `zoneAllocatedTokens`
- `zoneAcceptedTokens`
- `floorUnmet`
- `appliedFloorRelaxation`
- `degradationApplied`

### `context_arena_zone_adapted`

Adaptive zone controller update for next-turn zone caps. Common payload fields include:

- `movedTokens`
- `turn`
- `shifts` (`[{ from, to, tokens }]`)
- `maxByZone`

### `context_arena_slo_enforced`

Arena entry-count SLO enforcement event. Common payload fields include:

- `policy` (`drop_recall | drop_low_priority | force_compact`)
- `entriesBefore`
- `entriesAfter`
- `dropped`
- `source`

### `context_arena_floor_unmet_recovered`

Emitted when demanded zone floors were initially unmet but recovered by floor
relaxation / fallback policy. Common payload fields include:

- `reason` (`insufficient_budget_for_zone_floors`)
- `appliedFloorRelaxation`

### `context_arena_floor_unmet_unrecoverable`

Emitted when floor-unmet recovery cascade still cannot produce a viable
injection plan. Common payload fields include:

- `reason` (`insufficient_budget_for_zone_floors`)
- `appliedFloorRelaxation`

### `context_external_recall_skipped`

Emitted when external recall gating is evaluated but injection does not happen.
Common payload fields include:

- `reason` (`skill_tag_missing | internal_score_sufficient | provider_unavailable | no_hits | empty_block | arena_rejected | filtered_out`)
- `query`
- `internalTopScore`
- `threshold`

Note: `reason="filtered_out"` indicates external recall was accepted into the arena but removed by
final injection planning; write-back does not occur.

### `context_external_recall_injected`

Emitted when external recall content is injected and written back to memory.
Common payload fields include:

- `query`
- `hitCount`
- `internalTopScore`
- `threshold`
- `writebackUnits`

### `memory_recall_query_expanded`

Emitted when open memory insights contribute extra terms to recall query
construction. Common payload fields include:

- `terms`
- `termsCount`

### `memory_global_sync`

Global-memory lifecycle summary with counters and `globalSnapshotRef` pointer to persisted snapshot artifact.

### `tool_parallel_read`

Telemetry for runtime-aware multi-file read scans (mode, batch behavior, scanned/loaded/failed counts, limits).

### `exec_routed`

Records execution backend routing decisions before command execution. Common payload fields include:

- `mode`
- `configuredBackend`
- `resolvedBackend`
- `fallbackToHost`
- `enforceIsolation`
- `denyListBestEffort`
- `commandHash`
- `commandRedacted`
- `requestedCwd`
- `effectiveSandboxCwd`
- `requestedEnvKeys`
- `requestedTimeoutSec`
- `sandboxDefaultTimeoutSec`

### `exec_fallback_host`

Records sandbox-to-host downgrade decisions when fallback is allowed. Common payload fields include:

- `mode`
- `configuredBackend`
- `enforceIsolation`
- `denyListBestEffort`
- `reason`
- `commandHash`
- `commandRedacted`
- `error` (when fallback is triggered by sandbox execution errors)

### `exec_blocked_isolation`

Records fail-closed outcomes when command execution is blocked by isolation policy. Common payload fields include:

- `mode`
- `configuredBackend`
- `enforceIsolation`
- `denyListBestEffort`
- `reason`
- `commandHash`
- `commandRedacted`
- `detectedCommands` and `deniedCommand` (deny-list blocks)
- `denyListPolicy` (best-effort deny-list boundary note)

### `exec_sandbox_error`

Records sandbox execution errors before a fallback or fail-closed decision. Common payload fields include:

- `mode`
- `configuredBackend`
- `enforceIsolation`
- `denyListBestEffort`
- `commandHash`
- `commandRedacted`
- `error`

Exec audit events intentionally avoid storing raw command text. Use `commandHash` for correlation and
`commandRedacted` for operator diagnostics.

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
Exception: `cognitive_relevance_ranking*` is classified as ops-level for rerank observability.

## Replay and Query

Runtime query APIs:

- `runtime.events.query(sessionId, query?)`
- `runtime.events.queryStructured(sessionId, query?)`
- `runtime.events.listReplaySessions(limit?)`
- `runtime.events.subscribe(listener)`

Structured replay shape: `brewva.event.v1` (`BrewvaStructuredEvent`).

`BrewvaEventQuery` currently supports only:

- `type?: string`
- `last?: number`

## Current Limitations

- Event level filtering (`audit`/`ops`/`debug`) is applied at write time; filtered-out events are not persisted and cannot be recovered by later queries.
- Query API does not currently support time-range, offset cursor, or category filtering.
- `subscribe(listener)` is in-process only and does not replay historical events automatically.
