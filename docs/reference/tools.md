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

`lsp_diagnostics` returns `status=unavailable` with
`reason=diagnostics_scope_mismatch` when `tsc` fails but no diagnostics match
the requested file/severity scope.

## AST Tools

- `ast_grep_search`
- `ast_grep_replace`

Defined in `packages/brewva-tools/src/ast-grep.ts`.

`ast_grep_search` / `ast_grep_replace` require the `sg` binary (ast-grep).
If `sg` is unavailable or execution fails, tools return `status=unavailable`
with a reason/next-step hint instead of regex fallback.
Parameter surface is intentionally minimal:

- `ast_grep_search`: `pattern`, `lang`, optional `paths`
- `ast_grep_replace`: `pattern`, `rewrite`, `lang`, optional `paths`, optional `dryRun`

## Runtime-Aware Tools

Default tool bundle (registered by `buildBrewvaTools()`):

- `look_at`
- `exec`
- `process`
- `cost_view`
- `ledger_query`
- `output_search`
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

Optional A2A tools (registered by channel orchestration extensions when an A2A adapter is available):

- `agent_send`
- `agent_broadcast`
- `agent_list`

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

`output_search` supports query-mode and inventory-mode:

- query-mode: pass `query` or `queries`; results are ranked per artifact and include compact snippets.
- inventory-mode: omit both `query` and `queries` to list recent persisted artifacts.
- search behavior: exact -> partial -> fuzzy layered fallback.
- fuzzy results are emitted only when confidence gates pass; otherwise search reports no matches.
- throttling: repeated single-query calls can be limited or blocked; batch with `queries` to avoid pressure.
- source data: only persisted `tool_output_artifact_persisted` artifacts are scanned.

Definitions:

- `packages/brewva-tools/src/look-at.ts`
- `packages/brewva-tools/src/a2a.ts`
- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-tools/src/process.ts`
- `packages/brewva-tools/src/cost-view.ts`
- `packages/brewva-tools/src/ledger-query.ts`
- `packages/brewva-tools/src/output-search.ts`
- `packages/brewva-tools/src/schedule-intent.ts`
- `packages/brewva-tools/src/tape.ts`
- `packages/brewva-tools/src/session-compact.ts`
- `packages/brewva-tools/src/rollback-last-patch.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/skill-complete.ts`
- `packages/brewva-tools/src/task-ledger.ts`

`look_at` returns `status=unavailable` when it cannot find high-confidence
goal matches; it no longer falls back to returning top-of-file lines.
`look_at.goal` is English-ASCII only; non-ASCII goals return
`status=unavailable` with `reason=unsupported_goal_language`.
