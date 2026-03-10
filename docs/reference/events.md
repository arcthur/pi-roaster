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
- `debug_loop_*`
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
- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`
- `tool_surface_resolved`
- `context_composed`
- `memory_reference_rehydrated`
- `memory_reference_rehydration_failed`
- `memory_summary_rehydrated`
- `memory_summary_rehydration_failed`
- `memory_open_loop_rehydrated`
- `memory_open_loop_rehydration_failed`
- `cognitive_metric_first_productive_action`
- `cognitive_metric_resumption_progress`
- `cognitive_metric_rehydration_usefulness`
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

## Debug Loop Families

- `debug_loop_transition` records extension-owned state changes such as
  `forensics`, `debugging`, `implementing`, `blocked`, or `exhausted`, plus
  `retryCount` for the current loop state
- `debug_loop_artifact_persist_failed` records failed debug-loop durability
  writes, including artifact kind and absolute path
- `debug_loop_failure_case_persisted` records the on-disk failure snapshot used
  for retry and handoff
- `debug_loop_retry_scheduled` records the proposal-backed retry commitment and
  the next skill that should be loaded, including the post-failure `retryCount`
- `debug_loop_handoff_persisted` records the deterministic handoff packet path
- `debug_loop_reference_persisted` records the persisted cross-session
  cognition reference artifact path when terminal debug-loop state is promoted
  into deliberation-side sediment

These events are audit-visible because they describe controller decisions and
cross-turn recovery artifacts, not presentation-only UI behavior.

## Cognitive Product Families

- `context_composed` records the model-facing composition summary:
  narrative/constraint/diagnostic block counts plus token totals and the
  resulting narrative ratio
- `memory_*_rehydrated` / `memory_*_rehydration_failed` record whether
  cross-session cognition artifacts crossed the proposal boundary successfully
- `cognitive_metric_first_productive_action` records the first non-operator
  semantic `pass` tool result in a session
- `cognitive_metric_resumption_progress` records the first productive action
  after accepted memory rehydration
- `cognitive_metric_rehydration_usefulness` records whether accepted
  rehydration led to progress within the next two turns

## Proposal Boundary Notes

- `proposal_received` records the proposal envelope crossing from deliberation into the kernel boundary.
- `proposal_decided` records the kernel verdict: `accept`, `reject`, or `defer`.
- `decision_receipt_recorded` persists the full `proposal + receipt` pair into replayable tape.
- `skill_routing_selection` remains as projection telemetry for the latest
  `skill_selection` proposal outcome (`selected | empty | failed | skipped`),
  including `critical_compaction_gate` short-circuit paths.
- `skill_routing_decided` remains an internal commitment event for dispatch-gate
  state and recovery, not a public cognition API.

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
