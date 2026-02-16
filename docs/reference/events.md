# Reference: Events

Event system sources:

- Persistent store: `packages/roaster-runtime/src/events/store.ts`
- Runtime conversion and queries: `packages/roaster-runtime/src/runtime.ts`
- Extension bridge: `packages/roaster-extensions/src/event-stream.ts`

## Event Schemas

- `RoasterEventRecord`
- `RoasterStructuredEvent`
- `RoasterEventCategory`
- `RoasterReplaySession`

Defined in `packages/roaster-runtime/src/types.ts`.

## Common Event Types

- `session_start`
- `session_shutdown`
- `turn_start`
- `turn_end`
- `tool_call`
- `tool_result`
- `context_usage`
- `context_injected`
- `context_injection_dropped`
- `context_compaction_requested`
- `context_compaction_skipped`
- `context_compaction_breaker_opened`
- `context_compaction_breaker_closed`
- `context_compacted`
- `session_handoff_generated`
- `session_handoff_fallback`
- `session_handoff_skipped`
- `session_handoff_breaker_opened`
- `session_handoff_breaker_closed`
- `cost_update`
- `budget_alert`
- `session_snapshot_saved`
- `task_ledger_compacted`
- `session_resumed`
