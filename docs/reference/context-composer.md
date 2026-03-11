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
- capability view for the current turn
- admitted context entries from `runtime.context.buildInjection(...)`
- acceptance status for that injected context

Admitted entries come from the kernel admission path, not from ad-hoc extension
reads. There is no raw-text fallback path in the composer contract.

## Output Contract

The composer returns an ordered list of blocks:

- `narrative`
  - task state
  - truth facts
  - context packets
  - working projection
  - distilled failures/output summaries
- `constraint`
  - truth-ledger/static guardrails
  - dispatch or cascade gates
  - capability surface explanation
  - compaction gate/advisory blocks
- `diagnostic`
  - concise operational diagnostics only when explicitly requested or when
    compaction pressure requires additional explanation
  - compaction-triggered diagnostics stay minimal by default and do not include
    deep tape telemetry unless the model explicitly asked for diagnostic tools

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
