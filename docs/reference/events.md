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
- `verification_write_marked`
- `tool_result_recorded`
  Tool-result payloads now use `channelSuccess` for execution-channel success and `verdict` for semantic outcome.
  When present, `truthProjection` and `verificationProjection` are replayable
  derivation inputs, not second authority channels.
- `observability_assertion_recorded`
- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`
- `effect_commitment_approval_requested`
- `effect_commitment_approval_decided`
- `effect_commitment_approval_consumed`
- `verification_outcome_recorded`
- `event_listener_error`
- `governance_verify_spec_passed`
- `governance_verify_spec_failed`
- `governance_verify_spec_error`
- schedule lifecycle events
- skill cascade lifecycle events

These are retained under `infrastructure.events.level=audit`.

`event_listener_error` is audit-retained listener-isolation telemetry emitted
when a runtime event subscriber throws. The source event is still appended and
projected synchronously; the error event is durable evidence that fan-out
degraded without aborting later listeners.

## Operational Families

- `context_injected`
- `context_injection_dropped`
- `context_compaction_*`
- `context_arena_slo_enforced`
- `cost_update`
- `budget_alert`
- `observability_query_executed`
- `scan_convergence_*`
- `reversible_mutation_*`
- `effect_commitment_approval_*`
- `task_stuck_*`
- `tool_surface_resolved`
- `context_composed`
- `skill_*` lifecycle events outside cascade durability
- `skill_routing_selection`
- `skill_routing_decided`
- `debug_loop_*`
- `memory_*`
- `cognition_note_*`
- `cognitive_metric_*`
- `proactivity_wakeup_prepared`
- execution routing/isolation events
- `tool_output_observed`
- `tool_output_distilled`
- `tool_output_artifact_persisted`
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

`governance_verify_spec_*` is audit-retained because verifier/governance blockers
are now projected from that event family.
Other governance telemetry remains available at `ops` and `debug`.

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
- `debug_loop_retry_scheduled` records the direct cascade retry commitment and
  the next skill that should be loaded, including the post-failure `retryCount`
- `debug_loop_handoff_persisted` records the deterministic handoff packet path
- `debug_loop_reference_persisted` records the persisted cross-session
  cognition reference artifact path when terminal debug-loop state is promoted
  into deliberation-side sediment

These events are operational telemetry. They remain queryable at `ops`/`debug`
levels, but they no longer inflate audit-level tape retention.

## Cognitive Product Families

- `context_composed` records the model-facing composition summary:
  narrative/constraint/diagnostic block counts plus token totals and the
  resulting narrative ratio
- `memory_summary_written` / `memory_summary_write_failed` record the write-side
  cognition sediment loop at session boundaries
- `memory_*_rehydrated` / `memory_*_rehydration_failed` record whether
  cross-session cognition artifacts crossed the proposal boundary successfully
- `proactivity_wakeup_prepared` records control-plane wake-up metadata that may
  later influence memory selection before the model starts
- `cognition_note_written` / `cognition_note_write_failed` record explicit
  operator teaching writes into external cognition storage
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
- `skill_routing_decided` remains an internal commitment event for pending
  dispatch recommendation state and recovery, not a public cognition API.

## Reversible Mutation Receipt Events

- `reversible_mutation_prepared` records the selected reversible posture
  strategy before execution begins.
- `reversible_mutation_recorded` records the resulting rollback or journal
  anchor for `reversible_mutate` posture tools:
  - `workspace_write` tools point at a patchset-backed rollback anchor
  - task-ledger `memory_write` tools record before/after task-state journals
  - `cognition_note` records the written artifact reference when available
- `reversible_mutation_rolled_back` records the explicit rollback execution
  result for the last reversible receipt:
  - workspace patchset rollbacks capture restored vs failed paths
  - task-state journal rollbacks capture checkpoint replay success
  - unsupported rollback kinds remain explicit structured failures

## Effect Commitment Approval Desk Events

- `effect_commitment_approval_requested` records a pending operator approval
  request for one concrete commitment proposal when no host governance override
  authorizes it immediately.
  - the payload includes the concrete `effect_commitment` proposal so the desk
    can rebuild resume-ready request state from tape after restart
- `effect_commitment_approval_decided` records the explicit operator decision
  (`accept` or `reject`) for that pending request.
- `effect_commitment_approval_consumed` records the point where an accepted
  approval is consumed by an explicit resume of that exact pending request.
- together with `decision_receipt_recorded`, this event family is the replay
  source for the operator desk queue after restart.

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
