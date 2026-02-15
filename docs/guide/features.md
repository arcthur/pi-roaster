# Features

## Runtime Capabilities

- Skill contract selection and activation
- Tool access policy checks and budget checks
- Evidence ledger and digest injection
- Verification gates (`quick`, `standard`, `strict`)
- Context budget tracking and compaction events
- Session snapshot persistence and startup restore
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
- `cost_view`
- `ledger_query`
- `rollback_last_patch`
- `skill_load`
- `skill_complete`

Tool registry source: `packages/roaster-tools/src/index.ts`

## Skill Surface

- Base: `cartography`, `compose`, `debugging`, `exploration`, `git`, `patching`, `planning`, `review`, `verification`
- Packs: `browser`, `bun`, `frontend-ui-ux`, `react`, `typescript`
- Project: `roaster-project`

Skill roots:

- `skills/base`
- `skills/packs`
- `skills/project`
