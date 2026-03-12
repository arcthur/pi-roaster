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

`lsp_symbols` supports:

- `scope=document`: `filePath` must point to a file. Directories return a friendly error.
- `scope=workspace`: `query` is required and the tool scans code files under `cwd` (using runtime parallel-read when enabled).

`lsp_diagnostics` returns `status=unavailable` with
`reason=diagnostics_scope_mismatch` when `tsc` fails but no diagnostics match
the requested file/severity scope.

## TOC Tools

- `toc_document`
- `toc_search`

Defined in `packages/brewva-tools/src/toc.ts`.

Current scope is TS/JS only (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`).
The tools use TypeScript parser-based structural extraction, not regex-only
symbol scans.

`toc_document` returns:

- parameter: `file_path`
- module summary (top-of-file comment, first line only)
- imports
- top-level functions
- top-level interfaces, type aliases, and enums
- classes plus public methods/getters/setters
- line spans for targeted follow-up reads
- `status=unavailable` with `reason=file_too_large` when the file exceeds the
  structural parse budget; preferred follow-up is `read_spans` or `grep`

`toc_search` supports:

- `paths` (optional): one or more files/directories under the current workspace
- `limit` (optional): cap ranked matches
- broad-query fallback: returns `status=unavailable` with `reason=broad_query`
  when structural matches are too diffuse to be useful; preferred next step is
  a narrower symbol/import query or `grep`
- search-scope guard: returns `reason=search_scope_too_large` when the walk
  would index too many candidate files
- indexing-budget guard: returns `reason=indexing_budget_exceeded` when the
  current search would exceed the structural indexing byte budget
- follow-up contract: prefer `read_spans` for exact line ranges instead of
  whole-file reads

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

- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_diagnostics`
- `lsp_prepare_rename`
- `lsp_rename`
- `toc_document`
- `toc_search`
- `ast_grep_search`
- `ast_grep_replace`
- `look_at`
- `read_spans`
- `grep`
- `exec`
- `process`
- `cost_view`
- `obs_query`
- `obs_slo_assert`
- `obs_snapshot`
- `ledger_query`
- `output_search`
- `schedule_intent`
- `tape_handoff`
- `tape_info`
- `tape_search`
- `resource_lease`
- `session_compact`
- `rollback_last_patch`
- `cognition_note`
- `skill_load`
- `skill_complete`
- `skill_chain_control`
- `task_set_spec`
- `task_add_item`
- `task_update_item`
- `task_record_blocker`
- `task_resolve_blocker`
- `task_view_state`

Optional A2A tools (registered by channel orchestration extensions when an A2A adapter is available):

- `agent_send`
- `agent_broadcast`
- `agent_list`

Managed Brewva tools now expose governance metadata on the definition object
itself:

- `brewva.surface`
- `brewva.governance`

For built-in managed tools this is a canonical view over the runtime's exact
managed-tool policy, not a second authored copy. The default gateway/extension
path imports that metadata only when runtime does not already have an exact
descriptor for the tool, so tool disclosure and runtime effect governance can
share one policy source instead of drifting into parallel registries.

## Tool Surface Layers

The static registry is larger than the per-turn visible tool surface.

Current extension composition resolves three layers before `before_agent_start`:

- `base tools`
  - built-in core tools plus Brewva base governance tools
- `skill-informed tools`
  - preferred/fallback hints plus effect-authorized managed skill tools derived
    from the current active, pending-dispatch, or cascade-step skill contracts
- `operator tools`
  - operator-facing observability and control tools shown only for operator/full
    routing profiles by default or explicit `$tool_name` tool-surface requests
    in the capability view

Default product behavior:

- the capability view block shows only the tools that are visible now
- hidden managed Brewva tools can be surfaced for one turn by explicitly
  requesting `$tool_name`
- explicit `$tool_name` requests change disclosure for the current turn only;
  they do not grant authority on their own
- current skill/pending dispatch/cascade commitment still exposes its normal
  task-specific tool surface without needing `$tool_name`
- routing scopes that include `operator` or `meta` keep operator tools visible
  by default

This is enforced through active-tool selection, not by mutating kernel policy:

- runtime/skill contracts determine the exploration-oriented surface
- extensions narrow the visible tool list for the current turn
- runtime gates remain the fail-closed backstop for actual execution

Third-party or custom tools should register governance descriptors explicitly
through `registerToolGovernanceDescriptor(...)` if they need effect
authorization to participate in strict policy enforcement. Tools without
governance metadata remain usable, but runtime emits a warning because it cannot
enforce effect authorization for them yet.

Explicit exception:

- a small runtime-owned set of control-plane tools stays available for recovery,
  compaction, scheduling, and lease negotiation even when effect gating would
  otherwise hide them

`tool_surface_resolved` records the resolved visible surface for audit/ops
telemetry.

Notes:

- `grep` is a read-only workspace search tool intended to replace ad-hoc `exec` usage for text search in read-only skills.
- `read_spans` is the preferred targeted follow-up after `toc_document` / `toc_search`; it reads bounded line ranges from one file instead of replaying a whole file.
- `skill_chain_control` is the control-plane tool for inspecting and steering explicit cascade progression.
- Repeated `read`, `grep`, `read_spans`, `look_at`, `toc_*`, navigation-only `lsp_*`, `ast_grep_search`, or low-signal `exec` turns can trigger the scan convergence guard. Preferred recovery tools are `output_search`, `ledger_query`, `tape_search`, `task_view_state`, and `task_*` ledger actions before resuming more retrieval.
- `obs_query`, `obs_slo_assert`, and `obs_snapshot` are evidence-reuse tools. They inspect current-session runtime events and do not count as low-signal retrieval for scan-convergence reset.
- `cognition_note` is an operator teaching tool. It writes append-only
  external cognition artifacts (`reference`, `procedure`, `episode`) under
  `.brewva/cognition/*` and never mutates kernel truth/task state directly.

### `resource_lease`

Requests, lists, or cancels temporary budget expansions for the active skill.

Parameters:

- `action` (`request` | `list` | `cancel`, required)
- `reason` (string, required for `request`)
- `leaseId` (string, required for `cancel`)
- `maxToolCalls` (number, optional)
- `maxTokens` (number, optional)
- `maxParallel` (number, optional)
- `ttlMs` (number, optional)
- `ttlTurns` (number, optional)
- `includeInactive` (boolean, optional, `list` only)
- `skillName` (string, optional, `list` only)

Behavior:

- leases are budget-only; they do not grant new effect authorization
- lease requests require an active skill and are scoped to that skill
- granted budget is clamped by the skill hard ceiling before the lease is recorded
- requests fail when the active skill has no remaining headroom between
  `default_lease` and `hard_ceiling`
- granted, cancelled, and expired leases are replayable session events
- `resource_lease` is a narrow governance-owned direct-commit flow; it records
  budget receipts without widening effect authority

### `cognition_note`

Writes or supersedes high-signal operator cognition artifacts.

Parameters:

- `action` (`record` | `supersede` | `list`, required)
- `kind` (`reference` | `procedure` | `episode`, required for `record` and
  `supersede`)
- `name` (string, required for `record` and `supersede`)
- `title` (string, optional)
- `body` (string, optional)
- `sessionScope` (string, optional, `episode` only)
- `lessonKey` (string, optional, `procedure` only)
- `pattern` (string, optional, `procedure` only)
- `recommendation` (string, optional, `procedure` only)
- `focus` (string, optional, `episode` only)
- `nextAction` (string, optional, `episode` only)
- `blockedOn` (string or string[], optional, `episode` only)
- `limit` (number, optional, `list` only)

Behavior:

- `record`
  - appends a new operator-authored cognition artifact in the correct storage
    lane
  - rejects duplicate semantic names for the same `kind`
- `supersede`
  - appends a newer artifact with the same semantic name instead of editing the
    older file in place
  - retrieval and operator listing collapse older operator-authored versions by
    semantic key, so the newest artifact stays visible without rewriting
    history
- `list`
  - lists recent operator-authored cognition artifacts only
  - excludes system-generated memory artifacts
  - collapses superseded operator-authored versions to the latest semantic key

Storage mapping:

- `reference` -> `.brewva/cognition/reference/`
- `procedure` -> `.brewva/cognition/reference/`
- `episode` -> `.brewva/cognition/summaries/`

Scope model:

- operator-authored `reference` and `procedure` notes are workspace-scoped
- resumable `summary` process memory remains session-scoped through
  `session_scope`
- `cognition_note` may attach `sessionScope` to operator-authored `episode`
  notes when the note should participate in same-session rehydration

This tool is intentionally operator-scoped. It improves external cognition
input quality without bypassing the proposal boundary.

### `grep`

Wraps `ripgrep` (`rg`) with bounded output. Requires `rg` to be available on `PATH`.

Parameters:

- `query` (string, required): search pattern (regex by default)
- `paths` (string[], optional, max 20): paths to search (defaults to `["."]`)
- `glob` (string[], optional, max 20): glob filters passed to `rg --glob`
- `case` (`smart` | `ignore` | `sensitive`, default `smart`): case sensitivity mode
- `fixed` (boolean, default `false`): treat `query` as a literal string (`--fixed-strings`)
- `max_lines` (number, 1–500, default `200`): output line cap; search is killed on truncation
- `timeout_ms` (number, 100–120000, default `30000`): execution timeout
- `workdir` (string, optional): working directory (resolved relative to runtime `cwd`)

If `rg` is not found, the tool returns a hint to install ripgrep.

### `read_spans`

Reads exact line ranges from one file with bounded output.

Parameters:

- `file_path` (string, required): file to read
- `spans` (array, required, max 16): line ranges with `start_line` / `end_line`

Behavior:

- overlapping or adjacent spans are merged before reading
- ranges are clipped to file length
- when all requested ranges are outside the file, returns `status=unavailable`
  with `reason=out_of_bounds`
- when output is capped, the tool returns `last_line_returned` and
  `truncated_at_line` so follow-up calls can resume without recounting lines
- output is capped to avoid whole-file replay; use multiple narrower calls if needed
- when called after `toc_document` / `toc_search` in the same session, it
  reuses the same source-text cache instead of rereading the file immediately

### `skill_chain_control`

Inspects or controls the skill cascade intent lifecycle.

Parameters:

- `action` (`status` | `pause` | `resume` | `cancel` | `start`, required)
- `reason` (string, optional, max 500 chars): context for pause/resume/cancel
- `steps` (array, required for `start`, max 64): explicit chain steps, each with:
  - `skill` (string, required)
  - `consumes` (string[], optional)
  - `produces` (string[], optional)
  - `lane` (string, optional)

`status` returns the current intent snapshot or reports no active cascade.
`start` requires at least one step; other actions operate on the existing intent.

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

`obs_query` supports current-session structured event queries:

- filters: `types`, `where` (payload top-level exact match), `windowMinutes`, `last`
- optional metric aggregation: `count`, `min`, `max`, `avg`, `p50`, `p95`, `latest`
- output model: raw result is written as a tool-output artifact and the tool returns only a compact summary plus `query_ref`
- throttling: aligned with `output_search` single-query throttling (`90s` window; reduce after `4`; block after `10`)

`obs_slo_assert` evaluates a metric assertion over current-session runtime events:

- required fields: `metric`, `aggregation`, `operator`, `threshold`
- optional fields: `types`, `where`, `windowMinutes`, `minSamples`, `severity`
- verdicts: `pass`, `fail`, `inconclusive`
- failure path: records observability assertion evidence and can sync to truth/task state through runtime truth extraction

`obs_snapshot` returns a compact runtime health view:

- tape status
- context pressure
- cost summary
- task phase and blocker count
- latest verification outcome, when available

Definitions:

- `packages/brewva-tools/src/toc.ts`
- `packages/brewva-tools/src/look-at.ts`
- `packages/brewva-tools/src/read-spans.ts`
- `packages/brewva-tools/src/a2a.ts`
- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-tools/src/grep.ts`
- `packages/brewva-tools/src/process.ts`
- `packages/brewva-tools/src/cost-view.ts`
- `packages/brewva-tools/src/observability/obs-query.ts`
- `packages/brewva-tools/src/observability/obs-slo-assert.ts`
- `packages/brewva-tools/src/observability/obs-snapshot.ts`
- `packages/brewva-tools/src/ledger-query.ts`
- `packages/brewva-tools/src/output-search.ts`
- `packages/brewva-tools/src/schedule-intent.ts`
- `packages/brewva-tools/src/tape.ts`
- `packages/brewva-tools/src/session-compact.ts`
- `packages/brewva-tools/src/rollback-last-patch.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/skill-complete.ts`
- `packages/brewva-tools/src/skill-chain-control.ts`
- `packages/brewva-tools/src/task-ledger.ts`

`look_at` returns `status=unavailable` when it cannot find high-confidence
goal matches; it no longer falls back to returning top-of-file lines.
`look_at.goal` is English-ASCII only; non-ASCII goals return
`status=unavailable` with `reason=unsupported_goal_language`.
