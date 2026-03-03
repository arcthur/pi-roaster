// Control-plane tools bypass skill contract allowlists and budget enforcement.
// They must remain available to recover from partial failures and to complete lifecycle actions.
export const CONTROL_PLANE_TOOLS = [
  "skill_complete",
  "skill_load",
  "skill_route_override",
  "ledger_query",
  "cost_view",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "session_compact",
  "rollback_last_patch",
  "schedule_intent",
];

// Tools that remain usable even when context pressure is critical and the compaction gate is armed.
// Keep this list minimal: anything allowed here can bypass "compact-first" recovery.
export const CONTEXT_CRITICAL_ALLOWED_TOOLS = ["skill_complete", "session_compact"];
