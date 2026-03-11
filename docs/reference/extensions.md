# Reference: Extensions

Extension factory entrypoint: `packages/brewva-gateway/src/runtime-plugins/index.ts`.

Control-plane broker entrypoint: `packages/brewva-skill-broker/src/index.ts`.

Shared deliberation helpers: `packages/brewva-deliberation/src/index.ts`.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`

Factory options:

- `registerTools?: boolean` (default `true`)
- `profile?: "core" | "memory" | "debug" | "full"` (default `"core"`)

## Registered Handlers

Default extension composition (`profile="core"`) wires:

- `registerEventStream`
- `registerToolSurface`
- `registerContextTransform`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerToolResultDistiller`
- `registerCompletionGuard`

Optional profiles add:

- `memory`
  - `registerMemoryCurator`
  - `registerMemoryFormation`
  - `registerMemoryAdaptation`
- `debug`
  - `registerDebugLoop`
- `full`
  - all `memory` handlers
  - `registerDebugLoop`
  - `registerCognitiveMetrics`
  - `registerNotification`

Implementation files:

- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/cognitive-metrics.ts`
- `packages/brewva-gateway/src/runtime-plugins/proactivity-context.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts`
- `packages/brewva-gateway/src/runtime-plugins/ledger-writer.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-result-distiller.ts`
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`
- `packages/brewva-gateway/src/runtime-plugins/notification.ts`

## Tool Surface Resolution

`registerToolSurface` runs before context injection and narrows the visible
tool list for the current turn.

Resolution inputs:

- built-in always-on tools
- Brewva base governance tools
- tools declared by the current active/pending/cascade skill contracts
- operator/full routing profiles
- explicit capability requests such as `$task_view_state` or `$obs_query`

The extension updates only the active tool surface. Runtime policy, contract,
and compaction gates still decide whether execution is actually allowed.

Default behavior is intentionally narrow:

- explicit `$name` requests always expand capability details in the context block
- any managed Brewva tool can be surfaced for the current turn by that request path
- skill commitments still activate the normal task-specific tool surface without
  requiring `$name`
- operator/full routing profiles keep operator tools visible by default

Telemetry:

- `tool_surface_resolved`

## Scan Convergence Guard

Scan convergence is a runtime governance service. There is no dedicated
`registerScanConvergenceGuard` extension anymore; `registerEventStream`
forwards turn-end lifecycle into runtime, while classification, blocker writes,
event emission, restart hydration, and tool-call blocking stay inside runtime
services (`runtime.tools.start(...)`, `runtime.tools.finish(...)`,
`runtime.context.onUserInput(...)`, `runtime.context.onTurnEnd(...)`).

The runtime service classifies retrieval behavior into four tool strategies:

- `raw_scan`: `read`, `grep`
- `low_signal`: `look_at`, `read_spans`, `toc_document`, `toc_search`, `ast_grep_search`, selected `lsp_*` navigation tools, and low-signal `exec` commands such as `ls`/`find`/`cat`/`rg`
- `evidence_reuse`: `output_search`, `ledger_query`, `obs_query`, `obs_slo_assert`, `obs_snapshot`, `tape_info`, `tape_search`, `task_view_state`, `cost_view`
- `progress`: task mutation tools, skill lifecycle tools, handoff/mutation tools, and the remaining non-retrieval surface

The guard arms when a session accumulates repeated:

- `read`/`grep`-only turns
- low-signal investigation-only turns
- ENOENT / out-of-bounds raw scan failures

When armed, runtime:

- blocks additional `raw_scan` and `low_signal` tool calls
- records the task blocker `guard:scan-convergence`, which moves task status to `phase=blocked`
- resets only after a successful `evidence_reuse` or `progress` tool completion, or after fresh user input

This keeps the runtime aligned with the working-projection/task-ledger model: summarize current evidence first, then use task state or prior artifacts before resuming more retrieval.

`registerLedgerWriter` additionally persists tool-output observability events:

- `tool_output_observed`
- `tool_output_artifact_persisted`
- `tool_output_distilled`

`registerToolResultDistiller` runs after `registerLedgerWriter` and only patches
the current-turn `tool_result` content returned to the model. Raw evidence,
artifact persistence, and runtime ledger/truth writes still see the original
tool output first.

## Automatic Debug Loop

`registerDebugLoop` is an extension-side controller, not a runtime-kernel
service.

Its current responsibilities are:

- observe `skill_complete` inputs for active `implementation` sessions
- react to `verification_outcome_recorded` failures from `runtime.verification.*`
- persist deterministic debug-loop artifacts under `.orchestrator/artifacts/`
- start explicit cascade intents for `runtime-forensics -> debugging -> implementation`
  (or `debugging -> implementation` when `runtime_trace` already exists)
- publish short-lived `context_packet` summaries under `.brewva/cognition/summaries/`
  with a stable `packetKey=debug-loop:status`, so the latest retry/handoff
  summary can cross the proposal boundary without becoming kernel-owned memory
- synthesize deterministic `handoff.json` packets on `agent_end` and `session_shutdown`

The controller deliberately does not mutate `skill_complete` validation rules.
Minimum artifact-shape enforcement happens inside the controller before it
schedules the next retry or writes terminal handoff state.

`retryCount` is the number of scheduled retries after the first failed
implementation verification. The initial failure snapshot therefore persists
with `retryCount=0`.

`handoff.json` is latest-wins. Repeated lifecycle persistence overwrites the
previous handoff packet for the same session instead of keeping a history log.

Artifact persistence is fail-loud:

- successful writes emit `debug_loop_failure_case_persisted` /
  `debug_loop_handoff_persisted`
- failed writes emit `debug_loop_artifact_persist_failed` with the file kind and
  absolute path, so durability gaps still leave replayable evidence

When debug-loop emits a cognition summary packet:

- it stays in the Deliberation/Experience side as a `.brewva/cognition/summaries/*`
  artifact plus a `context_packet` proposal
- it uses the `status_summary` profile instead of free-form packet prose
- packet injection is scoped by the current leaf `scopeId` when available
- later retry/handoff summaries replace earlier ones during injection via the
  stable packet key instead of mutating kernel truth/task state
- terminal debug-loop handoff persistence may also write a longer-lived
  reference artifact under `.brewva/cognition/reference/` so later sessions can
  rehydrate the terminal investigation state through the proposal boundary

## Memory Curator

`registerMemoryCurator` is the optional control-plane entry point for
cross-session memory rehydration.

It does not turn cognition artifacts into kernel memory. Instead it:

- scans `.brewva/cognition/reference/` for prompt-relevant artifacts
- treats `ProcedureNote` artifacts as a semantic subset of the same
  `reference/` lane and rehydrates them with dedicated `procedure:*` packet
  keys
- scans `.brewva/cognition/summaries/` for prompt-relevant summaries and
  continuation-oriented open loops
- wraps selected artifacts as evidence-backed `context_packet` proposals
- relies on kernel receipts before those artifacts become visible as
  `brewva.context-packets`

Telemetry:

- `memory_reference_rehydrated`
- `memory_reference_rehydration_failed`
- `memory_procedure_rehydrated`
- `memory_procedure_rehydration_failed`
- `memory_summary_rehydrated`
- `memory_summary_rehydration_failed`
- `memory_open_loop_rehydrated`
- `memory_open_loop_rehydration_failed`

The curator may also consume recent proactivity wake-up metadata so heartbeat
or scheduler-triggered sessions can retrieve better artifacts than a raw prompt
match alone.

## Memory Formation

`registerMemoryFormation` is the write-side counterpart to `registerMemoryCurator`.

It:

- observes resumable lifecycle boundaries such as `agent_end`,
  `session_compact`, and `session_shutdown`
- writes status-summary cognition artifacts into `.brewva/cognition/summaries/`
- writes verification-backed `ProcedureNote` artifacts into
  `.brewva/cognition/reference/`
- records `memory_summary_written` / `memory_summary_write_failed`
- records `memory_procedure_note_written` /
  `memory_procedure_note_write_failed`
- keeps the write path outside the kernel so replayable commitments remain in
  tape while resumable cognition remains in deliberation-side artifacts

## Cognitive Metrics

`registerCognitiveMetrics` is `full`-profile-only telemetry about cognitive
product outcomes.

Current derived metrics:

- `cognitive_metric_first_productive_action`
- `cognitive_metric_resumption_progress`
- `cognitive_metric_rehydration_usefulness`

These metrics are derived from existing runtime evidence such as
`tool_result_recorded` and `memory_*_rehydrated` events. They do not introduce
new kernel authority.

## Memory Adaptation

`registerMemoryAdaptation` closes the control-plane feedback loop for memory
rehydration.

It:

- subscribes to replayable `cognitive_metric_rehydration_usefulness` events
- persists a small ranking policy under `.brewva/cognition/adaptation.json`
- records `memory_adaptation_updated` / `memory_adaptation_update_failed`
- leaves proposal admission, packet TTL, and scope semantics in the kernel

The adaptation policy affects future `registerMemoryCurator` ordering, not
kernel truth or task state.

## Proactivity Trigger Context

The current proactivity bridge is not an extension hook that mutates runtime
state. Instead:

- gateway/session workers record `proactivity_wakeup_prepared`
- `registerMemoryCurator` reads the latest wake-up metadata on
  `before_agent_start`
- the same proposal boundary and context-packet rules still apply

## Runtime Integration Contract

Extensions consume runtime domain APIs (for example `runtime.context.*`, `runtime.events.*`, `runtime.tools.*`) instead of legacy flat runtime methods.

Key implications:

- context injection path is async-first (`runtime.context.buildInjection(...)`)
- context pressure/compaction gate checks are delegated to `runtime.context.*`
- event writes/queries/subscriptions are delegated to `runtime.events.*`
- tool policy decisions are delegated to `runtime.tools.*`

## Context Transform Notes

`registerContextTransform` runs on `before_agent_start` and:

- applies a compact system-level context contract
- calls `ContextComposer` with kernel-admitted context entries
- injects a capability view block for progressive disclosure (compact tool list; expand with `$name`)
- enforces compaction gate behavior under critical context pressure
- projects proposal-derived selection telemetry (`skill_routing_selection`)

Boundary split:

- runtime context services own source registration, budget, deduplication, and
  admission
- `ContextComposer` owns block ordering and category (`narrative`,
  `constraint`, `diagnostic`)
- `registerContextTransform` remains the lifecycle adapter for `turn_start`,
  `context`, `before_agent_start`, `session_compact`, and `session_shutdown`

CLI and gateway session bootstrap prepend `createSkillBrokerExtension` before the runtime extension stack.
That broker:

- reads `.brewva/skills_index.json`
- reranks the shortlist against candidate skill previews (`Intent` / `Trigger` / boundary sections)
- optionally runs a control-plane `pi-ai complete()` judge over the shortlist or full catalog candidate set before selecting
- writes control-plane traces under `.brewva/skill-broker/<sessionId>/`
- submits `skill_selection` proposals through `@brewva/brewva-deliberation`
  helpers
- may start explicit cascade intents directly after accepted selection when a
  multi-step chain is already known

This broker path is an optional control-plane assist layer. Runtime kernel
selection remains outside the kernel, so kernel governance semantics stay
deterministic and replayable.

Default context injection sources are:

- `brewva.identity`
- `brewva.truth-static`
- `brewva.truth-facts`
- `brewva.skill-candidates`
- `brewva.skill-dispatch-gate`
- `brewva.skill-cascade-gate`
- `brewva.context-packets`
  - packets are scoped by `scopeId`, collapse by latest `packetKey`, and stop
    injecting after `expiresAt`
- `brewva.task-state`
- `brewva.tool-failures`
- `brewva.tool-outputs-distilled`
- `brewva.projection-working`

## Runtime Core Bridge (`--no-addons`)

`createRuntimeCoreBridgeExtension` / `registerRuntimeCoreBridge` provide a reduced extension surface when full extensions are disabled.

Retained hooks in this profile:

- `tool_call` (`registerQualityGate`) for runtime policy + compaction gate checks
- `tool_result` / `tool_execution_*` ledger persistence (`registerLedgerWriter`)
- same-turn pure-text `tool_result` distillation (`registerToolResultDistiller`)
- `registerCompletionGuard`
- `before_agent_start` narrative-first context composition over admitted runtime
  entries (`ContextComposer` + standard Brewva context contract)
- `session_compact` lifecycle bookkeeping
- `session_shutdown` lifecycle cleanup

Disabled full-extension hooks in this profile:

- `registerContextTransform` (`context` hook, auto-compaction lifecycle, full
  before-agent context adapter)
- `registerEventStream`
- all memory handlers
- `registerCognitiveMetrics`
- `registerDebugLoop`
- `registerNotification`

This means no-addons keeps core safety/evidence guarantees, but omits presentation-oriented lifecycle orchestration from the full extension stack.

## Channel Bridge Notes

Channel bridge helpers (`createRuntimeChannelTurnBridge`, `createRuntimeTelegramChannelBridge`) consume channel contracts from `@brewva/brewva-runtime/channels`, not runtime root exports.
