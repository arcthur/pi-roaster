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
- `tool_output_observed`
- `tool_output_distilled`
- `tool_output_artifact_persisted`
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
- `tool_output_search`

### `debug`

Debug level includes the full stream, including high-noise diagnostics such as:

- `cognitive_*`
- `tool_parallel_read`

Switching event level changes observability density, not runtime decision logic.

## Common Event Families

This list is intentionally non-exhaustive. Unknown event types/fields should be treated as forward-compatible.

### Session/Turn

- `session_start`
- `session_bootstrap`
- `session_shutdown`
- `input`
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
- `tool_output_observed`
- `tool_output_distilled`
- `tool_output_artifact_persisted`
- `tool_output_search` (ops/debug; excluded from audit)
- `tool_parallel_read`
- `ledger_compacted`
- `exec_routed`
- `exec_fallback_host`
- `exec_blocked_isolation`
- `exec_sandbox_error`

`tool_result` is the primary SDK hook boundary for semantic tool outcomes. Persisted, durable tool outcome records are emitted as `tool_result_recorded` (with correlated output telemetry emitted as `tool_output_observed`).

In rare cases, a tool may reach `tool_execution_end` but no SDK `tool_result` hook is observed (for example due to pre-result failures in wrapper paths). Brewva can synthesize a minimal outcome record to avoid ledger/tape gaps; synthesized outcomes are flagged via `lifecycleFallbackReason` in correlation payloads/metadata.

`tool_output_search` events are emitted by `output_search` to record throttling state,
cache behavior, and result counts. These events are intentionally operational (non-audit)
to avoid polluting audit-level streams with high-frequency search telemetry.

### Skill Routing

- `skill_activated`
- `skill_completed`
- `skill_routing_decided`
- `skill_routing_deferred`
- `skill_routing_followed`
- `skill_routing_overridden`
- `skill_routing_ignored`
- `skill_dispatch_gate_warning`
- `skill_dispatch_gate_blocked_tool`

### Task/Truth/Verification

- `task_event`
- `truth_event`
- `verification_state_reset`
- `verification_outcome_recorded`

### Context and Compaction

- `context_usage`
- `context_injected`
- `context_arena_slo_enforced`
- `context_injection_dropped`
- `context_external_recall_decision`
- `context_compaction_requested`
- `context_compaction_skipped`
- `context_compaction_gate_armed`
- `context_compaction_gate_blocked_tool`
- `context_compaction_gate_cleared`
- `critical_without_compact`
- `context_compacted`
- `session_compact`
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
- `cognitive_crystal_summary`
- `cognitive_crystal_summary_skipped`
- `cognitive_crystal_summary_failed`
- `cognitive_outcome_reflection`
- `cognitive_outcome_reflection_skipped`
- `cognitive_outcome_reflection_failed`

Note: runtime API is async-first. `cognitive_relevance_ranking` and
`cognitive_crystal_summary` can emit `asyncResult`, and `applied*` fields indicate
whether async results were actually applied to runtime state.

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

### `tool_call`

Operational correlation event emitted by the extension bridge before tool execution. Common payload fields include:

- `toolCallId`
- `toolName`

In rare cases, `tool_call` can be synthesized from the tool execution lifecycle stream (for example when `tool_execution_end` is observed without a preceding `tool_call`). Synthesized events include `lifecycleFallbackReason`.

### `tool_result_recorded`

Durable, replayable tool outcome emitted by the runtime ledger service. Common payload fields include:

- `toolName`
- `verdict` (`pass` | `fail` | `inconclusive`)
- `success` (boolean)
- `ledgerId` (correlation handle into the evidence ledger)
- `outputObservation` / `outputArtifact` / `outputDistillation` (when available)

Note: `tool_result_recorded` does not carry `toolCallId`. Correlate via `ledgerId` (and ledger-row metadata) or via `tool_output_*` events.

This event is normally produced from the SDK `tool_result` hook (via `ledger-writer`). If a tool reaches `tool_execution_end` but no `tool_result` hook is observed, Brewva can synthesize a minimal outcome record; the corresponding evidence-ledger row metadata includes `lifecycleFallbackReason` to make the path auditable.

### `session_bootstrap`

Session bootstrap summary emitted after runtime/session wiring. Common payload fields include:

- `cwd`
- `agentId`
- `extensionsEnabled`
- `skillLoad.activePacks`
- `skillLoad.skippedPacks` (`pack`, `source`, `rootDir`, `skillDir`, `reason`)

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

Common payload fields include:

- `outcome` (`pass` | `fail` | `skipped`)
- `level`
- `strategy`
- `lessonKey`
- `pattern`
- `failedChecks`
- `missingEvidence`
- `skipped` (boolean)
- `reason` (`read_only` | `null`)
- `provenanceVersion` (currently `v2`)
- `activeSkill`
- `referenceWriteAt`
- `evidenceFreshness` (`none` | `fresh` | `stale` | `mixed`)
- `commandsExecuted` / `commandsFresh` / `commandsStale` / `commandsMissing`
- `checkProvenance` (per-check command/freshness/ledger linkage)

Read-only sessions emit `outcome="skipped"` with `reason="read_only"`.

### `skill_routing_deferred`

Emitted when a new skill routing decision is recorded while another skill is still active and the decision is queued (pending dispatch gate).

Payload fields include the normal routing decision shape plus:

- `deferredBy` (active skill name)
- `deferredAtTurn` (runtime turn when deferral was observed)

### `skill_completed`

Skill lifecycle completion event emitted after contract output validation and
verification gate pass/skip.

Common payload fields include:

- `skillName`
- `outputKeys`
- `outputs`
- `completedAt`

### `session_compact`

Emitted when the SDK reports a session compaction has been performed.

Common payload fields include:

- `entryId` (compaction entry id when available)
- `fromExtension` (boolean, when compaction was triggered by an extension)

### `context_injected` and `context_injection_dropped`

Context planner telemetry summary. Common payload fields include:

- `degradationApplied` (boolean)

### `context_arena_slo_enforced`

Arena entry-count SLO enforcement event. Common payload fields include:

- `entriesBefore`
- `entriesAfter`
- `dropped`
- `source`

### `context_external_recall_decision`

Single external-recall decision summary event.
Common payload fields include:

- `outcome` (`skipped | injected | filtered_out`)
- `reason` (`pressure_gated | skill_tag_missing | internal_score_sufficient | provider_unavailable | no_hits | empty_block | arena_rejected | filtered_out`)
- `query`
- `internalTopScore`
- `threshold`
- `hitCount`
- `writebackUnits`

Note: `outcome="filtered_out"` means external recall was accepted into the arena but removed by
final injection planning; write-back does not occur.

### `context_compaction_gate_armed`

Emitted when runtime detects `critical` context pressure and requires compaction before non-exempt tools can proceed.

Common payload fields include:

- `reason` (`hard_limit`)
- `usagePercent` (ratio in `[0, 1]`, legacy field name)
- `hardLimitPercent` (ratio in `[0, 1]`, legacy field name)

### `context_compaction_gate_blocked_tool`

Emitted when a tool call is blocked because the compaction gate is armed.

Common payload fields include:

- `blockedTool`
- `reason` (`critical_context_pressure_without_compaction`)
- `usagePercent` (ratio in `[0, 1]`, legacy field name)
- `hardLimitPercent` (ratio in `[0, 1]`, legacy field name)

### `context_compaction_gate_cleared`

Emitted when the compaction gate is cleared after compaction is performed.

Common payload fields include:

- `reason` (`session_compact_performed`)

### `critical_without_compact`

Operational event emitted when `critical` pressure is observed and compaction is required but has not been performed yet.

Common payload fields include:

- `reason` (`hard_limit`)
- `usagePercent` (ratio in `[0, 1]`, legacy field name)
- `hardLimitPercent` (ratio in `[0, 1]`, legacy field name)
- `contextPressure` (`critical`)
- `requiredTool` (`session_compact`)

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
- `routingPolicy` (`best_available` | `fail_closed`)
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
- `routingPolicy`
- `configuredBackend`
- `enforceIsolation`
- `denyListBestEffort`
- `reason` (`sandbox_execution_error` | `sandbox_unavailable_cached` | `sandbox_unavailable_session_pinned`)
- `commandHash`
- `commandRedacted`
- `error` (when fallback is triggered by sandbox execution errors)
- `backoffMs`, `backoffUntil`, `backoffMsRemaining` (cache/backoff diagnostics)
- `sessionPinnedUntil`, `sessionPinTtlMs`, `sessionPinMsRemaining` (session-level pin diagnostics)

### `exec_blocked_isolation`

Records fail-closed outcomes when command execution is blocked by isolation policy. Common payload fields include:

- `mode`
- `routingPolicy`
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
- `routingPolicy`
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

### `cognitive_*`

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
