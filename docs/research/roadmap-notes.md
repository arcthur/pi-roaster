# Research: Roadmap Notes

This page captures systems-level priorities to keep infrastructure capabilities cohesive rather than ad hoc.

## Priority Themes

- Event stream consistency and replay fidelity
- Context budget behavior in long-running sessions
- Recovery robustness under interrupt conditions
- Cost observability and budget governance strategy
- Rollback ergonomics and patch lifecycle safety

## Source Anchors

- Runtime core: `packages/brewva-runtime/src/runtime.ts`
- Event stream hook: `packages/brewva-extensions/src/event-stream.ts`
- Context transform hook: `packages/brewva-extensions/src/context-transform.ts`
- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`
