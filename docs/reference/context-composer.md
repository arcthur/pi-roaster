# Reference: Context Composer

Implementation entrypoints:

- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`

## Role

`ContextComposer` is the model-facing composition step for extension profiles
that expose Brewva context to the model.

Current callers:

- `registerContextTransform` (full extension profile)
- `registerRuntimeCoreBridge` (`--no-addons` reduced profile)

It does not decide which sources exist or which sources fit the budget. It only
decides how already-admitted context should be shown to the model.

## Input Contract

`ContextComposer` consumes:

- `sessionId`
- current compaction-gate state
- pending compaction reason, if any
- capability-view tool-surface summary for the current turn
- admitted context entries from `runtime.context.buildInjection(...)`
- acceptance status for that injected context

Admitted entries come from the kernel admission path, not from ad-hoc extension
reads. There is no raw-text fallback path in the composer contract.

## Output Contract

The composer returns an ordered list of blocks:

- `narrative`
  - kernel-admitted narrative entries from `runtime.context.buildInjection(...)`
  - on the default path this typically means `brewva.identity`,
    `brewva.context-packets`, `brewva.runtime-status`, `brewva.task-state`, and
    `brewva.projection-working`
  - optional narrative providers may add `brewva.skill-candidates` or
    `brewva.tool-outputs-distilled`
- `constraint`
  - capability surface explanation
  - compaction gate/advisory blocks
  - any admitted constraint-category provider blocks such as
    `brewva.skill-cascade-gate`
- `diagnostic`
  - concise operational diagnostics only when explicitly requested or when
    compaction pressure requires additional explanation
  - tape telemetry appears only for explicit diagnostic tool requests surfaced
    through the capability view, such as `$tape_info`, `$tape_search`,
    `$obs_query`, `$obs_slo_assert`, or `$obs_snapshot`

Each block carries:

- `id`
- `category`
- `content`
- `estimatedTokens`

## Non-Goals

`ContextComposer` does not own:

- context-source registration
- budget clamp
- arena planning
- compaction lifecycle hooks
- tape replay

Those remain split across runtime services and extension lifecycle plumbing.

## Metrics

The composer emits `context_composed` telemetry from the lifecycle adapter with:

- narrative block count
- constraint block count
- diagnostic block count
- total composed tokens
- narrative tokens
- narrative ratio

This provides a direct measurement for the product rule:

`Model sees narrative.`
