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
- `agent_send`
- `agent_broadcast`
- `agent_list`
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

`schedule_intent` supports `action=create|update|cancel|list`:

- `create` requires `reason` and exactly one schedule target:
  - one-shot: `runAt` or `delayMs`
  - recurring: `cron` (optional `timeZone`)
  - `runAt` / `delayMs` / `cron` are mutually exclusive, and `timeZone` is only valid with `cron`
- `update` requires `intentId` and supports patching `reason`, `goalRef`,
  `continuityMode`, `maxRuns`, `convergenceCondition`, and schedule target fields;
  empty patches are rejected with `empty_update`
- `cancel` requires `intentId`
- `list` supports `status` filtering (`all|active|cancelled|converged|error`) and
  `includeAllSessions` (global scope), and returns projection `watermarkOffset`

Structured `convergenceCondition` predicates include:
`truth_resolved`, `task_phase`, `max_runs`, `all_of`, `any_of`.

For cron intents, runtime defaults `maxRuns` to `10000` when omitted.

Definitions:

- `packages/brewva-tools/src/look-at.ts`
- `packages/brewva-tools/src/a2a.ts`
- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-tools/src/process.ts`
- `packages/brewva-tools/src/cost-view.ts`
- `packages/brewva-tools/src/ledger-query.ts`
- `packages/brewva-tools/src/schedule-intent.ts`
- `packages/brewva-tools/src/tape.ts`
- `packages/brewva-tools/src/session-compact.ts`
- `packages/brewva-tools/src/rollback-last-patch.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/skill-complete.ts`
- `packages/brewva-tools/src/task-ledger.ts`
