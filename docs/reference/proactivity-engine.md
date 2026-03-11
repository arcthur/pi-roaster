# Reference: Proactivity Engine

Current implementation surfaces:

- `packages/brewva-gateway/src/runtime-plugins/proactivity-engine.ts`
- `packages/brewva-gateway/src/daemon/heartbeat-policy.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
- `packages/brewva-gateway/src/daemon/session-supervisor.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/runtime-plugins/proactivity-context.ts`

## Role

`ProactivityEngine` is the control-plane bridge between wake-up triggers and
model-facing cognition.

It does not decide commitments. It decides whether a trigger should wake
intelligence, builds the wake plan, and records replayable wake metadata so the
cognitive plane can rehydrate better memory before the model starts working.

Its output is a bounded wake plan, not a kernel mutation.

## Inputs

Current engine inputs may include:

- the heartbeat rule itself
- target session id
- current workspace cognition artifacts
- existing `objective` and `contextHints`
- recent unresolved `StatusSummary` open loops
- recent `EpisodeNote` artifacts

Resumable process-memory signals are filtered by target session scope before
they can influence wake decisions.

## Outputs

Current engine output is a `wake` or `skip` plan with:

- normalized `objective`
- normalized `contextHints`
- a bounded retrieval text used for curator query expansion
- optional semantic anchors from unresolved open loops or recent episodes
- a skip reason when wake-up is suppressed

## Current Trigger Path

Current heartbeat path:

1. `HeartbeatScheduler` fires a rule from `HEARTBEAT.md`.
2. Gateway asks `ProactivityEngine` to evaluate the rule and target session.
3. The engine either returns a wake plan or a skip plan.
4. On wake, gateway resolves the target session and sends the prompt through
   the session worker with the enriched trigger metadata.
5. The worker records `proactivity_wakeup_prepared` with rule id, objective,
   hints, and assembled wake context.
6. `MemoryCurator` reads the latest wake-up metadata on `before_agent_start`
   and expands its retrieval query before proposing `context_packet` hydration.
7. The model starts with accepted context, not just the raw heartbeat prompt.

When the engine returns `skip`, gateway does not open the session and broadcasts
an explicit `heartbeat.skipped` control-plane event instead.

## Heartbeat Rule Extensions

Heartbeat rules may optionally declare:

- `objective`
  - a durable description of why the wake-up exists
- `contextHints`
  - additional retrieval hints for the memory curator
- `wakeMode`
  - `always`, `if_signal`, or `if_open_loop`
  - controls when the engine may suppress a wake-up
- `staleAfterMinutes`
  - optional freshness limit for wake context signals

These fields are control-plane metadata. They do not bypass the proposal
boundary or create kernel truth.

## Wake Policy

Current wake policy is evaluated entirely outside the kernel:

- `always`
  - always wake the target session
- `if_signal`
  - wake only when the engine finds a relevant unresolved or recent cognition
    signal worth rehydrating
- `if_open_loop`
  - wake only when the engine finds an unresolved open loop

For `summary`, `episode`, and `open_loop` signals, relevance also requires a
matching target `session_scope`.

## Skip Policy

Current skip policy may suppress a trigger when:

- the rule requests `if_signal` but no relevant summary or episode signal exists
- the rule requests `if_open_loop` but no unresolved status summary exists
- the only available signals are stale beyond the configured freshness budget

Skipping is still explicit control-plane telemetry. It is not a silent drop.

## Wake Context Assembly

The engine assembles wake context from:

- the raw heartbeat prompt
- the normalized objective
- normalized context hints
- bounded unresolved open-loop or episode anchors

This text is not injected directly into the model. It is used to help
`MemoryCurator` retrieve better cognition artifacts before the model starts.

## Boundary Rules

`ProactivityEngine` may:

- decide whether to wake or skip
- attach wake-up metadata and retrieval hints
- assemble bounded wake context for retrieval
- influence future cognition selection through replayable trigger events

`ProactivityEngine` may not:

- mutate kernel state directly
- inject context without proposal receipts
- override runtime policy or compaction gates
