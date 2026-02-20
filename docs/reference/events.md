# Reference: Events

Event system sources:

- Persistent store: `packages/brewva-runtime/src/events/store.ts`
- Runtime conversion and queries: `packages/brewva-runtime/src/runtime.ts`
- Extension bridge: `packages/brewva-extensions/src/event-stream.ts`

## Event Schemas

- `BrewvaEventRecord`
- `BrewvaStructuredEvent`
- `BrewvaEventCategory`
- `BrewvaReplaySession`

Defined in `packages/brewva-runtime/src/types.ts`.

## Common Event Types

This list is intentionally non-exhaustive. Treat unknown event types and payload
fields as forward-compatible.

- `session_start`
- `session_shutdown`
- `turn_start`
- `turn_end`
- `tool_call`
- `tool_result_recorded`
- `tool_parallel_read`
- `task_event`
- `truth_event`
- `anchor`
- `checkpoint`
- `context_usage`
- `context_injected`
- `context_injection_dropped`
- `context_compaction_requested`
- `context_compaction_skipped`
- `context_compaction_gate_armed`
- `context_compaction_gate_blocked_tool`
- `context_compaction_gate_cleared`
- `critical_without_compact`
- `context_compacted`
- `session_compact_requested`
- `session_compact_request_failed`
- `cost_update`
- `budget_alert`
- `skill_budget_warning`
- `ledger_compacted`
- `viewport_built`
- `viewport_policy_evaluated`

## Raw vs Semantic Tool Events

- `tool_call` is the raw lifecycle event recorded by `event-stream`.
- Tool results are persisted as semantic runtime events (`tool_result_recorded`)
  through `ledger-writer -> runtime.recordToolResult()`.
- `tool_result` itself is treated as an SDK hook boundary, not a persisted tape
  event, to avoid duplicate result records in long sessions.

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
- `injected`: Whether the viewport text was injected as a `brewva.viewport`
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
- `skipped`: Does not inject the viewport text; a `brewva.viewport-policy` guard
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

## Tape Events

### `anchor`

Semantic boundary marker written by tape handoff flows.

Payload fields:

- `schema`: `brewva.tape.anchor.v1`
- `name`: phase/boundary name
- `summary`: optional structured phase summary
- `nextSteps`: optional next-step hint
- `createdAt`: event creation timestamp (epoch ms)

### `checkpoint`

Machine recovery baseline written by runtime checkpoint policy.

Payload fields:

- `schema`: `brewva.tape.checkpoint.v1`
- `state.task`: checkpointed task state
- `state.truth`: checkpointed truth state
- `basedOnEventId`: event id the checkpoint was derived from
- `latestAnchorEventId`: nearest semantic anchor id when available
- `reason`: checkpoint trigger reason
- `createdAt`: event creation timestamp (epoch ms)

## Task and Truth Ledger Events

### `task_event`

Event-sourced task ledger updates (`brewva.task.ledger.v1`) used to rebuild task state.
Payload `kind` includes:

- `spec_set`
- `checkpoint_set`
- `status_set`
- `item_added`
- `item_updated`
- `blocker_recorded`
- `blocker_resolved`

### `truth_event`

Event-sourced truth ledger updates (`brewva.truth.ledger.v1`) used to rebuild truth state.
Payload `kind` includes:

- `fact_upserted`
- `fact_resolved`

## Context Gate Events

### `critical_without_compact`

Emitted during `before_agent_start` when context usage is at critical pressure and
the runtime gate requires `session_compact` before continuing normal tool flow.

Payload fields:

- `usagePercent`: current context usage ratio (`0..1`) when available.
- `hardLimitPercent`: configured hard-limit ratio (`0..1`).
- `contextPressure`: currently fixed to `critical` for this event.
- `requiredTool`: currently fixed to `session_compact`.

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
