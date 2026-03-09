# Working Projection Journey

This journey describes the current working-projection runtime behavior after governance
kernel convergence.

## Goal

Keep projection state deterministic, auditable, and bounded:

- runtime projects source-backed records from tape events into `units.jsonl`
- runtime publishes a bounded working snapshot as an ordered entry list into `sessions/sess_<base64url(sessionId)>/working.md`
- context injection consumes only `brewva.projection-working`

There is no recall lane and no external recall branch in the default runtime.

## Runtime Flow

1. Event ingestion:
   - `runtime.events.record(...)` appends events to tape
   - `ProjectionEngine.ingestEvent(...)` extracts deterministic source-backed projection records
2. Projection refresh:
   - `ProjectionEngine.refreshIfNeeded(...)` rebuilds working snapshot from active projection records
   - output is persisted to `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/working.md`
3. Context injection:
   - `ContextProjectionInjectionService` injects only `brewva.projection-working`
   - injection still respects global context budget and compaction gate
4. Replay/recovery:
   - on restart, runtime rebuilds projection from source tape events when projection files are missing

## Persisted Artifacts

- `.orchestrator/projection/units.jsonl`
- `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/working.md`
- `.orchestrator/projection/state.json`

## Contract Notes

- Working projection is a projection, not source-of-truth.
- Tape events remain the source-of-truth.
- Tape checkpoint projection state is metadata-only (`updatedAt`, `unitCount`);
  it is observational and not a restorable semantic unit snapshot.
- Projection entries are keyed by source identity, not by heuristic importance classes.
- Any projection update path must stay deterministic and explainable.
