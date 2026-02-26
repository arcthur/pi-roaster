# Features

## Runtime Capabilities

- Skill contract selection and activation
- Tool access policy checks and budget checks
- Evidence ledger and digest injection
- Task/truth state management with event-sourced replay
- Verification gates (`quick`, `standard`, `strict`)
- Context budget tracking and compaction events
- Event-first runtime persistence and replay
- Cost observability and threshold-based budget alerts

## Tool Surface

- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_diagnostics`
- `lsp_prepare_rename`
- `lsp_rename`
- `ast_grep_search`
- `ast_grep_replace`
- `look_at`
- `exec`
- `process`
- `cost_view`
- `ledger_query`
- `schedule_intent`
- `tape_handoff`
- `tape_info`
- `tape_search`
- `session_compact`
- `rollback_last_patch`
- `skill_load`
- `skill_complete`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`
- `memory_dismiss_insight`
- `memory_review_evolves_edge`

Tool registry source: `packages/brewva-tools/src/index.ts`

## Skill Surface

- Base: `cartography`, `compose`, `debugging`, `exploration`, `git`, `patching`, `planning`, `review`, `verification`
- Packs: `agent-browser`, `frontend-ui-ux`, `gh-issues`, `github`, `skill-creator`, `telegram-interactive-components`
- Project: `brewva-project`

Skill roots:

- `skills/base`
- `skills/packs`
- `skills/project`
