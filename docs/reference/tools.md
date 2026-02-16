# Reference: Tools

Tool registry entrypoint: `packages/roaster-tools/src/index.ts`.

## LSP Tools

- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_diagnostics`
- `lsp_prepare_rename`
- `lsp_rename`

Defined in `packages/roaster-tools/src/lsp.ts`.

## AST Tools

- `ast_grep_search`
- `ast_grep_replace`

Defined in `packages/roaster-tools/src/ast-grep.ts`.

## Runtime-Aware Tools

- `look_at`
- `cost_view`
- `ledger_query`
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

- `packages/roaster-tools/src/look-at.ts`
- `packages/roaster-tools/src/cost-view.ts`
- `packages/roaster-tools/src/ledger-query.ts`
- `packages/roaster-tools/src/rollback-last-patch.ts`
- `packages/roaster-tools/src/skill-load.ts`
- `packages/roaster-tools/src/skill-complete.ts`
- `packages/roaster-tools/src/task-ledger.ts`
