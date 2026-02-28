# Brewva Runtime Artifact Catalog

Reference for all persistent artifacts the Brewva runtime produces during a session.
All paths are relative to the workspace root (detected via `.brewva/` marker or git root).

---

## 1. Event Store

| Property | Value                                                                       |
| -------- | --------------------------------------------------------------------------- |
| Path     | `.orchestrator/events/{sessionId}.jsonl`                                    |
| Format   | Newline-delimited JSON (JSONL)                                              |
| Producer | `BrewvaEventStore.append()` — `packages/brewva-runtime/src/events/store.ts` |

### Key Fields

| Field       | Type    | Description                                     |
| ----------- | ------- | ----------------------------------------------- |
| `id`        | string  | `evt_{timestamp}_{uuid}`                        |
| `sessionId` | string  | Session identifier                              |
| `type`      | string  | Event type (see below)                          |
| `timestamp` | number  | Unix epoch milliseconds                         |
| `turn`      | number? | Turn number (when applicable)                   |
| `payload`   | object? | Event-specific data (redacted in some contexts) |

### Event Types

| Type                        | Semantics                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `session_start`             | Session initialization                                                                           |
| `tool_call`                 | Tool invocation record                                                                           |
| `anchor`                    | Tape handoff anchor point                                                                        |
| `checkpoint`                | Tape checkpoint (task/truth/cost/evidence/memory replay slices)                                  |
| `context_injected`          | Context injection accepted with zone telemetry (`zoneDemandTokens`, `zoneAllocatedTokens`, etc.) |
| `context_injection_dropped` | Context injection rejected (budget/hard-limit/duplicate/floor_unmet path)                        |
| `context_arena_*`           | Arena control-plane events (`zone_adapted`, `slo_enforced`, `floor_unmet_*`)                     |
| `context_external_recall_*` | External recall boundary events (`skipped` / `injected`)                                         |
| `memory_*`                  | Memory engine lifecycle events                                                                   |
| `cost_update`               | Per-model / per-skill / per-tool cost delta                                                      |
| `ledger_compacted`          | Ledger compaction checkpoint                                                                     |

### Diagnostic Value

Primary correlation artifact. Every runtime action produces at least one event.
Use `sessionId` + `turn` to correlate with ledger rows and memory units.
Cost analysis: filter `type === "cost_update"` for per-model and per-tool budget consumption.
Context control-path analysis: inspect `context_injected`, `context_injection_dropped`,
`context_arena_*`, and `context_external_recall_*`.

---

## 2. Evidence Ledger

| Property | Value                                                                               |
| -------- | ----------------------------------------------------------------------------------- |
| Path     | `.orchestrator/ledger/evidence.jsonl`                                               |
| Format   | JSONL with **hash chain** integrity                                                 |
| Producer | `EvidenceLedger.append()` — `packages/brewva-runtime/src/ledger/evidence-ledger.ts` |

### Key Fields

| Field           | Type    | Description                                |
| --------------- | ------- | ------------------------------------------ |
| `id`            | string  | `ev_{timestamp}_{random}`                  |
| `sessionId`     | string  | Session identifier                         |
| `timestamp`     | number  | Unix epoch milliseconds                    |
| `turn`          | number  | Turn number                                |
| `skill`         | string? | Active skill name                          |
| `tool`          | string  | Tool that produced the evidence            |
| `argsSummary`   | string  | Truncated args (max 200 chars, redacted)   |
| `outputSummary` | string  | Truncated output (max 200 chars, redacted) |
| `outputHash`    | string  | SHA-256 of full output                     |
| `verdict`       | enum    | `"pass"` \| `"fail"` \| `"inconclusive"`   |
| `previousHash`  | string  | Hash of previous row (chain link)          |
| `hash`          | string  | SHA-256 of this row body                   |
| `metadata`      | object? | Optional structured metadata               |

### Hash Chain Property

Each row's `hash` is computed over its body fields plus `previousHash`.
**First diagnostic step**: verify chain continuity — a broken chain indicates
data corruption, out-of-order writes, or manual tampering.

### Compaction

The ledger periodically compacts old rows, retaining the most recent N entries
and inserting a `ledger_compacted` checkpoint event in the event store.

---

## 3. Memory Artifacts

Base directory: `.orchestrator/memory/`

### 3a. Memory Units — `units.jsonl`

| Field          | Type    | Description                                           |
| -------------- | ------- | ----------------------------------------------------- |
| `id`           | string  | Unit identifier                                       |
| `sessionId`    | string  | Originating session                                   |
| `type`         | string  | Unit type                                             |
| `status`       | string  | Lifecycle status                                      |
| `topic`        | string  | Topic cluster key                                     |
| `statement`    | string  | Core assertion                                        |
| `confidence`   | number  | Confidence score                                      |
| `fingerprint`  | string  | Dedup fingerprint                                     |
| `sourceRefs`   | array   | Source references                                     |
| `metadata`     | object? | Optional structured metadata                          |
| `createdAt`    | number  | Creation timestamp                                    |
| `updatedAt`    | number  | Last update timestamp                                 |
| `firstSeenAt`  | number  | First observed timestamp                              |
| `lastSeenAt`   | number  | Most recent observed timestamp                        |
| `resolvedAt`   | number? | Resolved timestamp (when status becomes resolved)     |
| `supersededAt` | number? | Superseded timestamp (when status becomes superseded) |

### 3b. Memory Crystals — `crystals.jsonl`

| Field        | Type    | Description                  |
| ------------ | ------- | ---------------------------- |
| `id`         | string  | Crystal identifier           |
| `sessionId`  | string  | Originating session          |
| `topic`      | string  | Topic cluster key            |
| `summary`    | string  | Aggregated summary           |
| `unitIds`    | array   | Constituent unit IDs         |
| `confidence` | number  | Aggregate confidence         |
| `sourceRefs` | array   | Source references            |
| `metadata`   | object? | Optional structured metadata |
| `createdAt`  | number  | Creation timestamp           |
| `updatedAt`  | number  | Last update timestamp        |

### 3c. Memory Insights — `insights.jsonl`

| Field            | Type    | Description                    |
| ---------------- | ------- | ------------------------------ |
| `id`             | string  | Insight identifier             |
| `sessionId`      | string  | Originating session            |
| `kind`           | string  | Insight category               |
| `status`         | string  | Lifecycle status               |
| `message`        | string  | Insight content                |
| `relatedUnitIds` | array   | Associated memory units        |
| `edgeId`         | string? | Evolution edge (if applicable) |
| `createdAt`      | number  | Creation timestamp             |
| `updatedAt`      | number  | Last update timestamp          |

### 3d. Memory Evolution Edges — `evolves.jsonl`

| Field          | Type   | Description             |
| -------------- | ------ | ----------------------- |
| `id`           | string | Edge identifier         |
| `sessionId`    | string | Originating session     |
| `sourceUnitId` | string | Predecessor unit        |
| `targetUnitId` | string | Successor unit          |
| `relation`     | string | Evolution relation type |
| `status`       | string | Edge status             |
| `confidence`   | number | Edge confidence         |
| `rationale`    | string | Justification           |
| `createdAt`    | number | Creation timestamp      |
| `updatedAt`    | number | Last update timestamp   |

### 3e. Memory State — `state.json`

| Field                 | Type   | Description                                    |
| --------------------- | ------ | ---------------------------------------------- |
| `schemaVersion`       | number | Schema version                                 |
| `lastPublishedAt`     | number | Last publish timestamp                         |
| `lastPublishedDayKey` | string | Calendar day key                               |
| `dirtyEntries`        | array  | Dirty topic entries triggering refresh/publish |

`dirtyEntries` rows have shape: `{ topic, reason, updatedAt }`.

| Field       | Type   | Description                                       |
| ----------- | ------ | ------------------------------------------------- |
| `topic`     | string | Topic key or directive key                        |
| `reason`    | string | Dirty reason (`new_unit`, `external_recall`, ...) |
| `updatedAt` | number | Last time this dirty reason was observed          |

### 3f. Working Memory — `working.md`

Markdown snapshot of current working memory, truncated to `maxWorkingChars` (default 2400).

### 3g. Global Memory Tier (optional)

When `memory.global.enabled` is on, global memory is projected into a dedicated store:

- `.orchestrator/memory/global/units.jsonl`
- `.orchestrator/memory/global/crystals.jsonl`
- `.orchestrator/memory/global/global-working.md`
- `.orchestrator/memory/global/global-decay.json`

Global tier rows use a synthetic `sessionId` (`"__global__"`).

### 3h. Global Sync Snapshots (optional)

When syncing/publishing global memory across sessions, the runtime may emit snapshot files:

- `.orchestrator/memory/global-sync/snapshot-*.json`

### Diagnostic Value

Cross-reference `units.jsonl` by `sessionId` and `topic` to trace how knowledge
evolved. `evolves.jsonl` edges reveal belief revision chains.

---

## 4. Tape Checkpoints

| Property | Value                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| Path     | Embedded in event store as events with `type: "checkpoint"`                                |
| Schema   | `brewva.tape.checkpoint.v1`                                                                |
| Producer | `TapeService.maybeRecordTapeCheckpoint()` — `packages/brewva-runtime/src/services/tape.ts` |
| Interval | Every `checkpointIntervalEntries` events (default: 120)                                    |

### Payload Fields

| Field                 | Type    | Description                      |
| --------------------- | ------- | -------------------------------- |
| `schema`              | string  | `"brewva.tape.checkpoint.v1"`    |
| `createdAt`           | number  | Checkpoint timestamp             |
| `reason`              | string  | Trigger reason                   |
| `basedOnEventId`      | string  | Last event ID at checkpoint time |
| `latestAnchorEventId` | string? | Latest tape anchor event         |
| `state.task`          | object  | Full `TaskState` snapshot        |
| `state.truth`         | object  | Full `TruthState` snapshot       |
| `state.cost`          | object? | Cost fold snapshot               |
| `state.evidence`      | object? | Evidence fold snapshot           |
| `state.memory`        | object? | Memory fold snapshot             |

### Diagnostic Value

Enables fast state reconstruction via `TurnReplayEngine`
(`packages/brewva-runtime/src/tape/replay-engine.ts`).
Instead of replaying all events from the start, locate the nearest checkpoint
before the target turn and replay forward from there.

---

## 5. File Change Snapshots

Base directory: `.orchestrator/snapshots/{sessionId}/`

### 5a. Patch History — `patchsets.json`

| Field       | Type   | Description           |
| ----------- | ------ | --------------------- |
| `version`   | number | Schema version        |
| `sessionId` | string | Session identifier    |
| `updatedAt` | number | Last update timestamp |
| `patchSets` | array  | Ordered patch sets    |

Each patch set contains: `id`, `createdAt`, `summary`, `toolName`, `appliedAt`,
and `changes[]` (with `path`, `action`, content hashes, snapshot file references).

### 5b. File Snapshots — `{hash}.snap`

Pre-mutation file contents stored as `{sha256(relativePath:beforeHash)}.snap`.
Used by `FileChangeTracker.rollbackLastPatchSet()` to restore files during undo.

Producer: `FileChangeTracker` — `packages/brewva-runtime/src/state/file-change-tracker.ts`

---

## 6. Schedule Projection

| Property | Value                                                                                   |
| -------- | --------------------------------------------------------------------------------------- |
| Path     | `.brewva/schedule/intents.jsonl`                                                        |
| Format   | JSONL (meta line + intent records)                                                      |
| Producer | `ScheduleProjectionStore.save()` — `packages/brewva-runtime/src/schedule/projection.ts` |

### Structure

- **Line 1 (meta)**: `{ schema, kind: "meta", generatedAt, watermarkOffset }`
- **Lines 2+**: `{ schema, kind: "intent", record: ScheduleIntentProjectionRecord }`

### Intent Record Fields

| Field               | Type    | Description              |
| ------------------- | ------- | ------------------------ |
| `intentId`          | string  | Unique intent identifier |
| `parentSessionId`   | string  | Owning session           |
| `reason`            | string  | Scheduling reason        |
| `goalRef`           | string  | Goal reference           |
| `cron`              | string? | Cron expression          |
| `runAt`             | number? | One-shot run timestamp   |
| `status`            | string  | Intent lifecycle status  |
| `nextRunAt`         | number? | Next scheduled execution |
| `consecutiveErrors` | number  | Error counter            |
| `lastError`         | string? | Most recent error        |

---

## Replay and Undo Infrastructure

### TurnReplayEngine

Location: `packages/brewva-runtime/src/tape/replay-engine.ts`

Reads from the event store JSONL, uses tape checkpoints for fast-forward,
and rebuilds `TaskState` + `TruthState` at any target turn. This is the
preferred diagnostic tool for reconstructing the exact runtime state at a
specific point in a session — avoids manual JSONL parsing.

### FileChangeTracker Rollback

Location: `packages/brewva-runtime/src/state/file-change-tracker.ts`

`rollbackLastPatchSet()` restores workspace files from pre-mutation snapshots.
Patch sets in `patchsets.json` record the full change graph for each tool action.

---

## Quick Reference: Correlation Keys

| Artifact            | Primary Key       | Cross-Reference                                        |
| ------------------- | ----------------- | ------------------------------------------------------ |
| Event Store         | `id`, `sessionId` | `turn` links to ledger rows                            |
| Evidence Ledger     | `id`, `sessionId` | `turn` links to events; `tool` links to tool registry  |
| Memory Units        | `id`, `sessionId` | `topic` clusters units; `sourceRefs` links to evidence |
| Tape Checkpoints    | `basedOnEventId`  | Links to event store for position                      |
| Patch History       | `patchSet.id`     | `toolName` links to tool call events                   |
| Schedule Projection | `intentId`        | `parentSessionId` links to event store                 |
