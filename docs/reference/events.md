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

This list is intentionally non-exhaustive. Treat unknown event types and payload
fields as forward-compatible.

- `session_start`
- `session_shutdown`
- `turn_start`
- `turn_end`
- `tool_call`
- `tool_result`
- `tool_parallel_read`
- `truth_event`
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
- `ledger_compacted`
- `task_ledger_snapshot_failed`
- `task_ledger_compacted`
- `session_resumed`
- `viewport_built`
- `viewport_policy_evaluated`

## Viewport Events

The runtime builds a lightweight "viewport" to ground the model in the most
relevant source text. It is derived from TaskSpec `targets.files` (or, when
missing, a small set of recently changed files) plus optional `targets.symbols`.

A simple signal-to-noise policy can downshift the viewport (or skip injecting it)
when the extracted context is likely to be misleading.

### `viewport_built`

Emitted when the runtime constructs a viewport candidate during
`buildContextInjection()`.

Payload fields:

- `goal`: The goal string used to extract relevant lines.
- `variant`: `full | no_neighborhood | minimal | skipped`
- `quality`: `good | ok | low | unknown`
- `score`: Policy decision score (`0..1`) or `null` when unavailable.
- `snr`: Keyword-based SNR reported by `buildViewportContext()` (`0..1`) or `null`.
- `effectiveSnr`: Effective SNR that treats symbol/neighborhood hits as signal.
- `policyReason`: Policy decision reason string.
- `injected`: Whether the viewport text was injected as a `roaster.viewport`
  context block.
- `requestedFiles`: Target files requested by the runtime (relative paths).
- `includedFiles`: Files that were successfully loaded and included.
- `unavailableFiles`: Files that were requested but could not be read.
- `importsExportsLines`: Count of import/export entries included in the viewport.
- `relevantTotalLines`: Count of relevant lines extracted (including fallback).
- `relevantHitLines`: Count of keyword-hit lines (0 in fallback mode).
- `symbolLines`: Count of symbol definition lines included.
- `neighborhoodLines`: Count of neighborhood definition lines included.
- `totalChars`: Final viewport text length (after truncation).
- `truncated`: Whether the viewport text was truncated to fit the budget.

Variants:

- `full`: Includes per-file imports/exports, relevant lines, symbols, and a small
  neighborhood expansion.
- `no_neighborhood`: Omits the neighborhood expansion to reduce noise.
- `minimal`: Omits both imports/exports and neighborhood to keep only the most
  directly relevant lines.
- `skipped`: Does not inject the viewport text; a `roaster.viewport-policy` guard
  block may be injected to force a verification-first posture.

### `viewport_policy_evaluated`

Emitted when the viewport policy makes a non-default choice (`variant != full`)
or when the selected `quality` is `low`.

Payload fields:

- `goal`, `variant`, `quality`, `score`, `snr`, `effectiveSnr`: Same semantics as
  `viewport_built`.
- `reason`: Policy decision reason string.
- `evaluated`: Array of evaluated viewport variants (always includes `full`).
  Each entry includes:
  - `variant`, `score`, `snr`, `effectiveSnr`
  - `truncated`, `totalChars`
  - `importsExportsLines`, `relevantTotalLines`, `relevantHitLines`
  - `symbolLines`, `neighborhoodLines`

## Snapshot and Ledger Events

### `task_ledger_snapshot_failed`

Emitted when the runtime fails to persist a task ledger snapshot.

Payload fields:

- `error`: Error message string.

## Tool Parallel Read Event

### `tool_parallel_read`

Emitted by runtime-aware tool implementations when they perform multi-file read
scans (for example, workspace-level `lsp_*` scans or `ast_grep_*` fallback
scans).

Payload fields:

- `toolName`: Tool that emitted the event (`lsp_symbols`, `lsp_find_references`,
  `ast_grep_search`, etc.).
- `operation`: Internal scan phase (`find_references`, `find_definition`,
  `naive_search`, `naive_replace`).
- `batchSize`: Effective concurrent read batch size used for this scan.
- `mode`: `parallel | sequential`.
- `reason`: Why the mode/batch was selected:
  - `runtime_parallel_budget`: derived from runtime `parallel` config
    (`min(maxConcurrent, maxTotal) * 4`, clamped to `[1, 64]`).
  - `parallel_disabled`: runtime `parallel.enabled=false` forced sequential mode.
  - `runtime_unavailable`: tool ran without runtime config context.
- `scannedFiles`: Number of file read attempts made by the scan.
- `loadedFiles`: Number of files successfully read.
- `failedFiles`: Number of files that failed to read.
  (`scannedFiles = loadedFiles + failedFiles`)
- `batches`: Number of read batches executed.
- `durationMs`: End-to-end scan duration in milliseconds.
