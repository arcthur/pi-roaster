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
- capability-view semantic disclosure state for the current turn
  - `inventory` for visible-now summary, posture counts, hidden-surface counts,
    and disclosure hints
  - `policies` for disclosure and posture-boundary rules
  - `requested` for explicit `$name` requests parsed from the turn prompt
  - `details` for requested capability semantics selected for rendering
  - `missing` for requested names that do not map to a known tool
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
  - rendered capability disclosure blocks derived from the semantic capability
    view
  - this may include `capability-view-summary`, `capability-view-policy`,
    optional `capability-view-inventory`, requested `capability-detail:*`, and
    `capability-detail-missing`
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

## Capability Disclosure Resolution

`ContextComposer` first measures admitted narrative tokens, then chooses a
render profile for capability disclosure:

- healthy narrative headroom keeps full disclosure plus inventory
- moderate pressure keeps full policy and requested details but drops inventory
- tighter pressure switches to compact summary/policy/detail rendering

After rendering, governance trimming still happens in semantic order instead of
raw string truncation:

- non-operational diagnostics first
- optional inventory
- compaction advisory
- compact capability detail/policy, then compact summary
- generic capability policy before requested diagnostic capability detail
- operational diagnostics last

This keeps explicit `$name` detail requests more stable than inventory or
decorative hints when context pressure increases.

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

The same `narrativeRatio` also drives capability disclosure resolution, so
posture-aware tool detail can degrade by tier before requested semantics are
dropped outright.
