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
- `skill_completed`
- `task_event`
- `truth_event`
- `verification_state_reset`
- `memory_unit_upserted`
- `memory_unit_superseded`
- `memory_crystal_compiled`
- `memory_working_published`
- `memory_insight_recorded`
- `memory_insight_dismissed`
- `memory_evolves_edge_reviewed`
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

### `verification_state_reset`

Emitted when runtime verification state is explicitly cleared (for example after
rollback) before subsequent verification runs rebuild fresh evidence.

Payload fields:

- `reason`: reset trigger reason (currently `rollback`).

Example payload:

```json
{
  "reason": "rollback"
}
```

## Memory Projection Events

### `skill_completed`

Emitted when `completeSkill()` accepts outputs and finalizes an active skill.

Payload fields:

- `skillName`: completed skill name.
- `outputKeys`: sorted output keys submitted by `skill_complete` (trimmed list).
- `completedAt`: completion timestamp (epoch ms).

Example payload:

```json
{
  "skillName": "debugging",
  "outputKeys": ["root_cause", "verification"],
  "completedAt": 1730000000000
}
```

### `memory_unit_upserted`

Emitted when memory extractor writes/merges a `Unit` projection row.

Payload fields:

- `unitId`: memory unit id.
- `topic`: normalized unit topic.
- `unitType`: `fact | decision | constraint | preference | pattern | hypothesis | learning | risk`.
- `created`: whether this was a first insert vs merge update.
- `confidence`: normalized unit confidence (`0..1`).

Example payload:

```json
{
  "unitId": "memu_1730000000000_ab12cd34",
  "topic": "verification",
  "unitType": "risk",
  "created": false,
  "confidence": 0.92
}
```

### `memory_unit_superseded`

Emitted when a memory unit transitions to status `superseded`, typically as a side-effect of accepting a proposed evolves edge.

Payload fields:

- `unitId`: superseded unit id.
- `supersededAt`: supersede transition time (epoch ms).
- `supersededByUnitId`: the newer unit id that superseded this one (when available).
- `edgeId`: evolves edge id that triggered the change (when available).
- `relation`: evolves relation label (`replaces | enriches | confirms | challenges`).

Example payload:

```json
{
  "unitId": "memu_old",
  "supersededAt": 1730000001000,
  "supersededByUnitId": "memu_new",
  "edgeId": "meme_1730000000700_qr78st90",
  "relation": "replaces"
}
```

### `memory_crystal_compiled`

Emitted when memory compiler writes/updates a `Crystal` aggregate.

Payload fields:

- `crystalId`: crystal id.
- `topic`: crystal topic.
- `unitCount`: number of backing units.
- `confidence`: aggregate confidence (`0..1`).

Example payload:

```json
{
  "crystalId": "memc_1730000000000_ef56gh78",
  "topic": "database architecture",
  "unitCount": 6,
  "confidence": 0.84
}
```

### `memory_working_published`

Emitted when working memory markdown is regenerated and published to disk.

Payload fields:

- `generatedAt`: publication timestamp (epoch ms).
- `units`: number of source units used.
- `crystals`: number of source crystals used.
- `insights`: number of included insights.
- `chars`: final published text length.

Example payload:

```json
{
  "generatedAt": 1730000000123,
  "units": 18,
  "crystals": 4,
  "insights": 2,
  "chars": 2140
}
```

### `memory_insight_recorded`

Emitted when memory pipeline writes an insight (for example conflict/evolves pending).

Payload fields:

- `insightId`: insight id.
- `kind`: `conflict | evolves_pending`.
- `message`: rendered insight text.
- `relatedUnitIds`: associated unit ids (when available).
- `edgeId`: evolves edge id (only for `evolves_pending` when available).
- `relation`: evolves relation label (`replaces | enriches | confirms | challenges`) for evolves insight.

Kind-specific field matrix:

| `kind`            | `relatedUnitIds`           | `edgeId`                                       | `relation`                                  |
| ----------------- | -------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `conflict`        | optional (usually present) | not used                                       | not used                                    |
| `evolves_pending` | optional                   | optional (present when an evolves edge exists) | optional (present when `edgeId` is present) |

Example payload:

```json
{
  "insightId": "memi_1730000000456_ij90kl12",
  "kind": "conflict",
  "message": "Potential conflict in topic 'verification' with 2 active statements.",
  "relatedUnitIds": ["memu_1730000000000_ab12cd34", "memu_1730000000010_cd34ef56"]
}
```

Example payload (`evolves_pending`):

```json
{
  "insightId": "memi_1730000000789_mn34op56",
  "kind": "evolves_pending",
  "edgeId": "meme_1730000000700_qr78st90",
  "relation": "challenges",
  "message": "Pending evolves: edge=meme_1730000000700_qr78st90 topic='verification' relation=challenges (memu_new -> memu_old)."
}
```

### `memory_insight_dismissed`

Emitted when an open memory insight is explicitly dismissed.

Payload fields:

- `insightId`: dismissed insight id.

Example payload:

```json
{
  "insightId": "memi_1730000000456_ij90kl12"
}
```

### `memory_evolves_edge_reviewed`

Emitted when a proposed evolves edge is manually accepted/rejected.

Payload fields:

- `edgeId`: evolves edge id.
- `status`: `accepted | rejected`.
- `relation`: evolves relation label (`replaces | enriches | confirms | challenges`).
- `sourceUnitId`: source (newer) unit id.
- `targetUnitId`: target (older) unit id.

Example payload:

```json
{
  "edgeId": "meme_1730000000700_qr78st90",
  "status": "accepted",
  "relation": "challenges",
  "sourceUnitId": "memu_new",
  "targetUnitId": "memu_old"
}
```

## Context Gate Events

### `critical_without_compact`

Emitted during `before_agent_start` when context usage is at critical pressure and
the runtime gate requires `session_compact` before continuing normal tool flow.

Payload fields:

- `usagePercent`: current context usage ratio (`0..1`) when available.
- `hardLimitPercent`: configured hard-limit ratio (`0..1`).
- `contextPressure`: currently fixed to `critical` for this event.
- `requiredTool`: currently fixed to `session_compact`.

### `context_compaction_skipped`

Emitted after `context_compaction_requested` when compaction is not executed
immediately in the current flow.

Payload fields:

- `reason`: why compaction was skipped in-place.
  - `manual_compaction_required`: interactive/UI sessions. Runtime requested
    compaction and expects an explicit `session_compact` tool call.
  - `non_interactive_mode`: non-interactive print/json flows. Runtime requested
    compaction but no interactive compaction path is available.

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

Mode/reason matrix:

| `reason`                  | `mode`                     | `batchSize` behavior                                                   |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `runtime_unavailable`     | `parallel`                 | fixed default `16`                                                     |
| `parallel_disabled`       | `sequential`               | fixed `1`                                                              |
| `runtime_parallel_budget` | `parallel` or `sequential` | `clamp(min(maxConcurrent, maxTotal) * 4, 1, 64)`; `1` means sequential |

Example payload:

```json
{
  "toolName": "lsp_symbols",
  "operation": "find_references",
  "batchSize": 32,
  "mode": "parallel",
  "reason": "runtime_parallel_budget",
  "scannedFiles": 24,
  "loadedFiles": 24,
  "failedFiles": 0,
  "batches": 1,
  "durationMs": 183
}
```
