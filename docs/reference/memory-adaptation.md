# Reference: Memory Adaptation

Implementation entrypoint:

- `packages/brewva-gateway/src/runtime-plugins/memory-adaptation.ts`

## Role

`MemoryAdaptation` closes the control-plane feedback loop for cross-session
rehydration.

It does not introduce kernel memory, vector indexes, or hidden deliberation
authority. It only observes replayable cognitive outcome telemetry and persists
a small policy that later influences `MemoryCurator` and `MemoryFormation`.

## Inputs

Current observation source:

- `cognitive_metric_rehydration_usefulness`

Packet identity is carried through:

- `rehydrationKinds`
- `rehydrationPackets[].kind`
- `rehydrationPackets[].packetKey`
- `rehydrationPackets[].artifactRef`

## Persistence

Policy file:

- `.brewva/cognition/adaptation.json`

Schema:

- `brewva.memory_adaptation_policy.v1`

Current policy tracks:

- strategy-level usefulness for `reference`, `procedure`, `episode`,
  `summary`, and `open_loop`
- packet-level usefulness keyed by `packetKey`
- timestamps for last observation and last useful outcome

Graceful degradation rule:

- missing or corrupt adaptation state degrades to an empty policy
- cognitive-product execution must continue without blocking session startup

The policy is control-plane state. It is not kernel truth, task state, ledger
state, or tape replacement.

## Output

Current output path:

- `MemoryCurator` reads the policy on `before_agent_start`
- candidate ranking is nudged by packet-level and strategy-level bias before
  proposals are submitted
- packet-level bias is intentionally weighted more strongly because a concrete
  packet history is a sharper signal than a strategy-wide average
- `MemoryFormation` may derive write-side guidance from the same policy
  to suppress low-signal summaries, episodes, or procedures
- proposal admission, TTL, and scope rules still belong to the kernel

## Telemetry

- `memory_adaptation_updated`
- `memory_adaptation_update_failed`

These events remain replayable evidence of control-plane policy changes.

## Boundary Rules

`MemoryAdaptation` may:

- read replayable usefulness telemetry
- persist control-plane ranking bias
- influence future `MemoryCurator` ordering
- influence future `MemoryFormation` quality gates

`MemoryAdaptation` may not:

- mutate kernel commitments directly
- bypass proposal receipts
- rewrite cognition artifacts
- inject context on its own
