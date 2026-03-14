export const TOOL_RESULT_RECORDED_EVENT_TYPE = "tool_result_recorded" as const;
export const TOOL_OUTPUT_OBSERVED_EVENT_TYPE = "tool_output_observed" as const;
export const TOOL_OUTPUT_DISTILLED_EVENT_TYPE = "tool_output_distilled" as const;
export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool_output_artifact_persisted" as const;
export const OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE = "observability_query_executed" as const;
export const OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE =
  "observability_assertion_recorded" as const;
export const PROPOSAL_RECEIVED_EVENT_TYPE = "proposal_received" as const;
export const PROPOSAL_DECIDED_EVENT_TYPE = "proposal_decided" as const;
export const DECISION_RECEIPT_RECORDED_EVENT_TYPE = "decision_receipt_recorded" as const;
export const RESOURCE_LEASE_GRANTED_EVENT_TYPE = "resource_lease_granted" as const;
export const RESOURCE_LEASE_CANCELLED_EVENT_TYPE = "resource_lease_cancelled" as const;
export const RESOURCE_LEASE_EXPIRED_EVENT_TYPE = "resource_lease_expired" as const;

export const EXEC_ROUTED_EVENT_TYPE = "exec_routed" as const;
export const EXEC_FALLBACK_HOST_EVENT_TYPE = "exec_fallback_host" as const;
export const EXEC_BLOCKED_ISOLATION_EVENT_TYPE = "exec_blocked_isolation" as const;
export const EXEC_SANDBOX_ERROR_EVENT_TYPE = "exec_sandbox_error" as const;

export const VERIFICATION_WRITE_MARKED_EVENT_TYPE = "verification_write_marked" as const;
export const VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE = "verification_outcome_recorded" as const;
export const VERIFICATION_STATE_RESET_EVENT_TYPE = "verification_state_reset" as const;
export const TASK_STUCK_DETECTED_EVENT_TYPE = "task_stuck_detected" as const;
export const TASK_STUCK_CLEARED_EVENT_TYPE = "task_stuck_cleared" as const;
export const TOOL_POSTURE_SELECTED_EVENT_TYPE = "tool_posture_selected" as const;
export const REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE = "reversible_mutation_prepared" as const;
export const REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE = "reversible_mutation_recorded" as const;
export const REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE =
  "reversible_mutation_rolled_back" as const;
export const EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE =
  "effect_commitment_approval_requested" as const;
export const EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE =
  "effect_commitment_approval_decided" as const;
export const EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE =
  "effect_commitment_approval_consumed" as const;
export const SCAN_CONVERGENCE_ARMED_EVENT_TYPE = "scan_convergence_armed" as const;
export const SCAN_CONVERGENCE_ADVISORY_EVENT_TYPE = "scan_convergence_advisory" as const;
export const SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE = "scan_convergence_blocked_tool" as const;
export const SCAN_CONVERGENCE_RESET_EVENT_TYPE = "scan_convergence_reset" as const;
export const DEBUG_LOOP_TRANSITION_EVENT_TYPE = "debug_loop_transition" as const;
export const DEBUG_LOOP_FAILURE_CASE_PERSISTED_EVENT_TYPE =
  "debug_loop_failure_case_persisted" as const;
export const DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE =
  "debug_loop_artifact_persist_failed" as const;
export const DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE = "debug_loop_retry_scheduled" as const;
export const DEBUG_LOOP_HANDOFF_PERSISTED_EVENT_TYPE = "debug_loop_handoff_persisted" as const;
export const MEMORY_SUMMARY_WRITTEN_EVENT_TYPE = "memory_summary_written" as const;
export const MEMORY_SUMMARY_WRITE_FAILED_EVENT_TYPE = "memory_summary_write_failed" as const;
export const MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE = "memory_reference_rehydrated" as const;
export const MEMORY_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE =
  "memory_reference_rehydration_failed" as const;
export const MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE = "memory_summary_rehydrated" as const;
export const MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE =
  "memory_summary_rehydration_failed" as const;
export const PROACTIVITY_WAKEUP_PREPARED_EVENT_TYPE = "proactivity_wakeup_prepared" as const;
export const COGNITION_NOTE_WRITTEN_EVENT_TYPE = "cognition_note_written" as const;
export const COGNITION_NOTE_WRITE_FAILED_EVENT_TYPE = "cognition_note_write_failed" as const;
export const COGNITIVE_METRIC_FIRST_PRODUCTIVE_ACTION_EVENT_TYPE =
  "cognitive_metric_first_productive_action" as const;
export const COGNITIVE_METRIC_RESUMPTION_PROGRESS_EVENT_TYPE =
  "cognitive_metric_resumption_progress" as const;
export const COGNITIVE_METRIC_REHYDRATION_USEFULNESS_EVENT_TYPE =
  "cognitive_metric_rehydration_usefulness" as const;

export const PROJECTION_INGESTED_EVENT_TYPE = "projection_ingested" as const;
export const PROJECTION_REFRESHED_EVENT_TYPE = "projection_refreshed" as const;

export const SKILL_CASCADE_PLANNED_EVENT_TYPE = "skill_cascade_planned" as const;
export const SKILL_CASCADE_STEP_STARTED_EVENT_TYPE = "skill_cascade_step_started" as const;
export const SKILL_CASCADE_STEP_COMPLETED_EVENT_TYPE = "skill_cascade_step_completed" as const;
export const SKILL_CASCADE_PAUSED_EVENT_TYPE = "skill_cascade_paused" as const;
export const SKILL_CASCADE_REPLANNED_EVENT_TYPE = "skill_cascade_replanned" as const;
export const SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE = "skill_cascade_overridden" as const;
export const SKILL_CASCADE_FINISHED_EVENT_TYPE = "skill_cascade_finished" as const;
export const SKILL_CASCADE_ABORTED_EVENT_TYPE = "skill_cascade_aborted" as const;

export const SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE = "schedule_recovery_deferred" as const;
export const SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE = "schedule_recovery_summary" as const;
export const SCHEDULE_WAKEUP_EVENT_TYPE = "schedule_wakeup" as const;
export const SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE = "schedule_child_session_started" as const;
export const SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE =
  "schedule_child_session_finished" as const;
export const SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE = "schedule_child_session_failed" as const;
