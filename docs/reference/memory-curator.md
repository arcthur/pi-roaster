# Reference: Memory Curator

Implementation entrypoint:

- `packages/brewva-extensions/src/memory-curator.ts`

Supporting helpers:

- `packages/brewva-deliberation/src/cognition.ts`
- `packages/brewva-deliberation/src/proposals.ts`

## Role

`MemoryCurator` is the single control-plane entry point for cross-session
cognition rehydration.

It does not create kernel memory. It selects non-authoritative cognition
artifacts and re-enters them through the proposal boundary as `context_packet`
proposals.

## Current Strategies

Current built-in strategies:

- `reference match`
  - scan `.brewva/cognition/reference/`
  - select prompt-relevant artifacts by term overlap and recency
  - submit evidence-backed `context_packet` proposals with TTL-bound packet keys
- `summary resume`
  - scan `.brewva/cognition/summaries/`
  - select prompt-relevant status summaries by term overlap and recency
  - re-enter them through the same proposal/receipt path
- `open-loop resume`
  - scan recent `.brewva/cognition/summaries/` status summaries
  - on continuation-oriented prompts, select the most recent unresolved
    summary with a `next_action`, `blocked_on`, or unresolved status
  - this is a semantic filter over the `summaries` lane, not a third storage
    lane
  - rehydrate it as a scoped `context_packet` instead of mutating kernel state

Current issuer:

- `brewva.extensions.memory-curator`

Current telemetry:

- `memory_reference_rehydrated`
- `memory_reference_rehydration_failed`
- `memory_summary_rehydrated`
- `memory_summary_rehydration_failed`
- `memory_open_loop_rehydrated`
- `memory_open_loop_rehydration_failed`

## Boundary Rules

`MemoryCurator` may:

- read cognition artifacts
- rank/select artifacts outside the kernel
- submit `context_packet` proposals

`MemoryCurator` may not:

- mutate truth, task, ledger, or tape state directly
- bypass proposal receipts
- inject cognition artifacts implicitly

## Expansion Rule

Future strategies must still be added under the same curator entry point. The
goal is to avoid multiple independent rehydration hooks competing for the same
context budget with incompatible policies.
