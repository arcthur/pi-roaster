// Control-plane tools bypass normal skill effect authorization and budget enforcement.
// They must remain available to recover from partial failures and to complete lifecycle actions.
export const CONTROL_PLANE_TOOLS = [
  "skill_complete",
  "skill_chain_control",
  "skill_load",
  "resource_lease",
  "ledger_query",
  "cost_view",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "session_compact",
  "rollback_last_patch",
  "schedule_intent",
  "cognition_note",
];

// Tools that remain usable even when context pressure is critical and the compaction gate is armed.
// Keep this list minimal: anything allowed here can bypass "compact-first" recovery.
export const CONTEXT_CRITICAL_ALLOWED_TOOLS = [
  "skill_complete",
  "ledger_query",
  "cost_view",
  "tape_info",
  "tape_search",
];
