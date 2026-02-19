# Reference: Tools

Tool registry entrypoint: `packages/brewva-tools/src/index.ts`.

## LSP Tools

- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_diagnostics`
- `lsp_prepare_rename`
- `lsp_rename`

Defined in `packages/brewva-tools/src/lsp.ts`.

## AST Tools

- `ast_grep_search`
- `ast_grep_replace`

Defined in `packages/brewva-tools/src/ast-grep.ts`.

## Runtime-Aware Tools

- `look_at`
- `exec`
- `process`
- `cost_view`
- `ledger_query`
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

Definitions:

- `packages/brewva-tools/src/look-at.ts`
- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-tools/src/process.ts`
- `packages/brewva-tools/src/cost-view.ts`
- `packages/brewva-tools/src/ledger-query.ts`
- `packages/brewva-tools/src/tape.ts`
- `packages/brewva-tools/src/session-compact.ts`
- `packages/brewva-tools/src/rollback-last-patch.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/skill-complete.ts`
- `packages/brewva-tools/src/task-ledger.ts`
