# Research: Roadmap Notes

This page tracks cross-cutting priorities still in incubation. Each theme
should either be promoted into stable docs or explicitly archived after review.

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-02-26`
- Promotion target: `docs/architecture/*.md` and `docs/reference/*.md`

## Priority Themes

### 1) Event stream consistency and replay fidelity

Goal:
Ensure major lifecycle transitions remain queryable and replay can derive state
without hidden process-local assumptions.

Source anchors:

- Runtime core wiring: `packages/brewva-runtime/src/runtime.ts`
- Event stream hook: `packages/brewva-extensions/src/event-stream.ts`
- Event store and query path: `packages/brewva-runtime/src/events/store.ts`

Related docs:

- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/events.md`
- `docs/journeys/session-handoff-and-reference.md`

Validation signals:

- Replay correctness remains covered in `test/runtime/turn-replay-engine.test.ts`
- Event query behavior remains covered in `test/runtime/tape-event-store.test.ts`

Promotion criteria:

- Event-level guarantees are documented in architecture invariants.
- Replay/query contract details are documented in reference pages.

### 2) Context budget behavior in long-running sessions

Goal:
Keep memory/context injection bounded and deterministic under large histories.

Source anchors:

- Context transform hook: `packages/brewva-extensions/src/context-transform.ts`
- Runtime context budget service: `packages/brewva-runtime/src/context/budget.ts`
- Runtime context API wiring: `packages/brewva-runtime/src/runtime.ts`

Related docs:

- `docs/journeys/context-and-compaction.md`
- `docs/reference/configuration.md`
- `docs/reference/limitations.md`

Validation signals:

- Context budget behavior remains covered in `test/runtime/context-budget.test.ts`
- Context injection behavior remains covered in `test/runtime/context-injection.test.ts`

Promotion criteria:

- Configurable vs internal budget knobs are explicitly documented.
- Operator-facing failure modes are captured in troubleshooting docs.

### 3) Recovery robustness under interrupt conditions

Goal:
Ensure restart/recovery remains deterministic when turns are interrupted.

Source anchors:

- Turn WAL append/recover: `packages/brewva-runtime/src/channels/turn-wal.ts`
- Tape replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- CLI replay/undo entrypoint: `packages/brewva-cli/src/index.ts`

Related docs:

- `docs/architecture/invariants-and-reliability.md`
- `docs/journeys/operations-and-debugging.md`
- `docs/reference/session-lifecycle.md`

Validation signals:

- Replay/persistence scenarios pass in `test/e2e/replay-and-persistence.live.test.ts`
- Signal handling scenarios pass in `test/e2e/signal-handling.live.test.ts`

Promotion criteria:

- Recovery data dependencies are explicitly documented by lifecycle phase.
- Incident debug sequence is documented as an operational journey.

### 4) Cost observability and budget governance

Goal:
Maintain transparent cost accounting and predictable budget alerts.

Source anchors:

- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`
- Runtime cost surface wiring: `packages/brewva-runtime/src/runtime.ts`
- Session bootstrap and reporting path: `packages/brewva-cli/src/session.ts`

Related docs:

- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/journeys/operations-and-debugging.md`

Validation signals:

- Cost tracking behavior remains covered in `test/e2e/cost-tracking.live.test.ts`
- Runtime cost API docs stay aligned with runtime surface tests.

Promotion criteria:

- Budget policy and alert semantics are explicit in reference docs.
- Operational cost diagnosis path is explicit in journey docs.

### 5) Rollback ergonomics and patch lifecycle safety

Goal:
Keep rollback behavior predictable and bounded to tracked mutations.

Source anchors:

- Rollback tracking state: `packages/brewva-runtime/src/state/file-change-tracker.ts`
- Runtime rollback wiring: `packages/brewva-runtime/src/runtime.ts`
- Rollback tool contract: `packages/brewva-tools/src/rollback-last-patch.ts`

Related docs:

- `docs/architecture/invariants-and-reliability.md`
- `docs/journeys/operations-and-debugging.md`
- `docs/reference/tools.md`

Validation signals:

- Rollback behavior remains covered in `test/e2e/undo.live.test.ts`
- Tool flow contract remains covered in `test/runtime/tools-flow.test.ts`

Promotion criteria:

- Rollback safety guarantees are reflected in architecture invariants.
- Tool-level rollback contract is explicit in reference docs.
