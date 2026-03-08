export const TOOL_RESULT_RECORDED_EVENT_TYPE = "tool_result_recorded" as const;
export const TOOL_OUTPUT_OBSERVED_EVENT_TYPE = "tool_output_observed" as const;
export const TOOL_OUTPUT_DISTILLED_EVENT_TYPE = "tool_output_distilled" as const;
export const TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE = "tool_output_artifact_persisted" as const;

export const EXEC_ROUTED_EVENT_TYPE = "exec_routed" as const;
export const EXEC_FALLBACK_HOST_EVENT_TYPE = "exec_fallback_host" as const;
export const EXEC_BLOCKED_ISOLATION_EVENT_TYPE = "exec_blocked_isolation" as const;
export const EXEC_SANDBOX_ERROR_EVENT_TYPE = "exec_sandbox_error" as const;

export const VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE = "verification_outcome_recorded" as const;
export const VERIFICATION_STATE_RESET_EVENT_TYPE = "verification_state_reset" as const;
export const TASK_STUCK_DETECTED_EVENT_TYPE = "task_stuck_detected" as const;
export const TASK_STUCK_CLEARED_EVENT_TYPE = "task_stuck_cleared" as const;

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
