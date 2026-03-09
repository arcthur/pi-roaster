# Runtime Events

This reference summarizes the current event families after governance-kernel
convergence.

## Event Envelope

Every runtime event follows the same envelope shape:

- `id`
- `sessionId`
- `type`
- `timestamp`
- `turn` (optional)
- `payload` (optional)

## Audit-Critical Families

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- `tool_result_recorded`
  Tool-result payloads now use `channelSuccess` for execution-channel success and `verdict` for semantic outcome.
- `observability_assertion_recorded`
- `verification_outcome_recorded`
- schedule lifecycle events
- execution routing/isolation events

These are retained under `infrastructure.events.level=audit`.

## Operational Families

- `context_injected`
- `context_injection_dropped`
- `context_compaction_*`
- `context_arena_slo_enforced`
- `cost_update`
- `budget_alert`
- `observability_query_executed`
- `scan_convergence_*`
- `task_stuck_*`
- `skill_*` lifecycle and cascade events
- `skill_routing_selection`
- `skill_routing_decided`
- `turn_wal_*`

These are retained under `ops` and `debug`.

## Governance Families

- `governance_verify_spec_passed`
- `governance_verify_spec_failed`
- `governance_verify_spec_error`
- `governance_cost_anomaly_detected`
- `governance_cost_anomaly_error`
- `governance_compaction_integrity_checked`
- `governance_compaction_integrity_failed`
- `governance_compaction_integrity_error`

Governance events are available at `ops` and `debug` levels and remain replayable from tape.

## Projection Families

- `projection_ingested`
- `projection_refreshed`

Projection events describe deterministic projection state only.
They are observational telemetry and do not carry a full semantic projection
snapshot that can replace source-event replay.

## Skill Routing Notes

- `skill_routing_selection` records the runtime routing result projection as `selected`, `empty`, `failed`, or `skipped` (critical compaction gate), regardless of whether the source was the deterministic kernel selector or external preselection.
- `skill_routing_decided` records the dispatch decision after routing and before explicit `skill_load` activation.

## Scan Convergence Guard Events

- `scan_convergence_armed` records why the guard armed:
  - `reason=scan_only_turns`
  - `reason=investigation_only_turns`
  - `reason=scan_failures`
- `scan_convergence_armed` also includes current counters, `blockedStrategy`, `blockedTools`, `recommendedStrategyTools`, and the active thresholds.
- `scan_convergence_blocked_tool` records the blocked tool name, its `toolStrategy`, the active guard reason, and the counters at block time.
- `scan_convergence_reset` records `reason=strategy_shift|input_reset`, the previous arm reason, and the strategy class that successfully cleared the guard.

Guard arm/reset also has a task-ledger side effect: runtime records or resolves the blocker `guard:scan-convergence`, so task status surfaces the convergence stop as `phase=blocked` until the strategy changes.

## Task Progress Watchdog Events

- `task_stuck_detected` records that a gateway session worker observed no semantic task progress beyond the watchdog threshold.
- `task_stuck_detected` may record `blockerWritten=false` with `suppressedBy=guard:scan-convergence` when a more specific convergence guard is already active.
- `task_stuck_cleared` records turn-start cleanup after semantic progress resumes beyond the persisted watchdog blocker timestamp.
- `task_stuck_cleared` payload distinguishes `resumedProgressAt` (when progress resumed) from `clearedAt` (when the persisted watchdog blocker was actually cleared).
- The watchdog writes a task blocker (`watchdog:task-stuck:no-progress`) only when no more-specific blocker is already active. The event family remains `ops`-level; task-ledger blocker writes remain audit-visible through `task_event`.

## Removed Families

The following families are not part of the current kernel path:

- adaptive inference event families
- multi-tier adaptive projection enrichment families
- optional external retrieval decision families
