# Research: Invocation Spine, Posture Policy, and Injection Shaping vNext

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-03-14`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/events.md`

## Direct Conclusion

The next-generation `brewva` runtime no longer models governance as "every tool
passes through the same blocking chain." Instead, it is built around:

- a shared `Invocation Spine`
- three `posture policy` modes attached to that shared envelope
  - `observe`
  - `reversible_mutate`
  - `commitment`
- an injection-side budget-shaping model
- a session-local progressive trust model

The governing principle is not "less governance." It is "govern only at the
effect boundary, not along the thought path."

## Problem Statement

Before the refactor, `tool-gate`, `stall-detector`, and `context budget`
created three structural problems:

1. `tool-gate` combined the shared invocation skeleton with governance blocking
   - That made any attempt to reduce friction for low-risk paths likely to
     damage hard boundaries such as WAL, ledger, usage observation, and file
     tracking.
2. `stall-detector` combined exploration convergence with task stagnation
   - Part of its logic was thought-path guidance
   - The rest was a lane-agnostic watchdog
3. `context-composer` tracked `narrative / constraint / diagnostic`
   classification
   - But it did not turn governance injection into a real injection-side budget
     with enforceable limits

As a result:

- exploration was mechanically cut off too early
- governance metadata competed with reasoning context for prompt space
- the runtime did not separate the observable invocation skeleton from the
  effect-posture decision

## Goals

- Preserve hard boundaries such as WAL, deterministic injection, event replay,
  and ledger.
- Allow `observe`-posture exploration to continue instead of being hard-blocked
  directly by scan convergence.
- Route `exec`, external side effects, and schedule mutation into explicitly
  higher-governance postures.
- Turn budget handling into runtime-controlled injection shaping rather than
  pretending to control the entire context window.
- Let trust grow from session-local evidence, but consume it only through
  advisory frequency and threshold adjustments, not direct capability-surface
  changes.

## Non-Goals

- Do not revert the runtime back to a `bub`-style near-zero-governance model.
- Do not downgrade the task watchdog into an advisory-only mechanism.
- Do not turn trust into a cross-session long-lived reputation system.

## Core Model

### 1. Shared Invocation Spine

All tool calls must enter the shared skeleton first. The shared skeleton is
always responsible for:

- context usage observation
- invocation lifecycle event
- file-change tracking hook
- ledger/tool result recording
- finish lifecycle tracking

In other words, low-risk paths may skip blocking-style governance, but they may
not skip the observability skeleton.

```ts
interface InvocationSpine {
  begin(input: StartToolCallInput): InvocationFrame;
  finish(input: FinishToolCallInput): string;
}
```

### 2. Posture Policy

`lane` is not modeled as three separate execution pipelines. It is modeled as
three governance postures layered onto the shared invocation skeleton.

```ts
type ToolInvocationPosture = "observe" | "reversible_mutate" | "commitment";
```

Posture classification rules:

- `observe`
  - `workspace_read`
  - `runtime_observe`
- `reversible_mutate`
  - `workspace_write`
  - `memory_write`
- `commitment`
  - `local_exec`
  - `external_network`
  - `external_side_effect`
  - `schedule_mutation`

### 3. Decouple Exploration Supervisor From Task Watchdog

Exploration convergence and task stagnation are not the same problem:

- `ExplorationSupervisor`
  - owns scan convergence
  - emits advisory-only guidance for `observe`
  - may still retain hard-block behavior for higher postures
- `TaskWatchdog`
  - owns long-running lack of semantic progress
  - is posture-agnostic
  - continues to write blocker and watchdog events

### 4. Injection-Side Budget Shaping

The runtime cannot truly know which tokens in the full context window belong to
model reasoning. It can, however, control how much governance information it
injects itself.

For that reason, budget is not defined as "70% reasoning reserve." It is
defined as:

- `governance injection cap`
  - enforce a hard limit on `constraint + diagnostic`
- `narrative floor`
  - ensure narrative blocks are not squeezed out by governance content

Trimming order:

1. trim `diagnostic` first
2. trim optional `constraint` next
3. compress `capability-view` last

### 5. Session-Local Trust

Trust v1 only performs session-local adjustment.

Inputs:

- observe-posture tool outcomes
- reversible-mutate posture tool outcomes
- verification and rollback outcomes in later stages

Outputs:

- scan-convergence advisory frequency
- exploration threshold boost
- reversible-mutate batch thresholds in a later phase

v1 does not:

- persist trust across sessions
- dynamically change capability visibility
- relax commitment-posture authority

## Event Model

New events:

- `tool_posture_selected`
- `scan_convergence_armed`
- `scan_convergence_advisory`
- `scan_convergence_blocked_tool`
- `scan_convergence_reset`

Of these:

- `scan_convergence_advisory` is a lightweight diagnostic event consumable from
  the prompt side
- `tool_posture_selected` is the foundational telemetry that makes the runtime's
  effect-posture decision explicit

## Code Boundaries

Primary target files for the first refactor stage:

- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/exploration-supervisor.ts`
- `packages/brewva-runtime/src/services/task-watchdog-service.ts`
- `packages/brewva-runtime/src/services/trust-meter.ts`
- `packages/brewva-runtime/src/governance/tool-governance.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`

## Implementation Milestones

### Completed Stage A

- Introduce `ToolInvocationPosture`
- Refactor `tool-gate` into a shared envelope plus posture policy
- Split `stall-detector`
- Change `observe` posture from hard block to advisory
- Add the injection-side governance cap
- Ship a minimal session-local trust implementation

### Completed Stage B

- Add explicit state journals / rollback artifacts for `memory_write`
- Add mutation receipts for `reversible_mutate`
- Add a receipt-bearing authorization desk for `commitment`

### Completed Stage C

- Connect verification and rollback cleanliness into trust
- Deeply integrate commitment policy with proposal admission
- Turn capability view into a posture-aware surface

## Risks

1. Opening up the `observe` path may increase low-signal scanning
   - Mitigation: advisory guidance, trust-throttled hints, and the context cap
2. `commitment` now requires explicitly resuming the exact request; if the host
   surface does not project that recovery action, the system can feel harder to
   operate
   - Mitigation: keep `runtime.tools.start(..., effectCommitmentRequestId)` as
     the single recovery entry point, and project approval interactions clearly
     at the host/channel layer
3. `rollbackLastPatchSet(...)` and `rollbackLastMutation(...)` now share a
   single source of truth, but workspace rollback still preserves an LIFO
   constraint
   - Mitigation: return a structured failure for non-latest patchsets instead
     of rolling back the wrong patchset

## Current Implementation Status

The current implementation has completed the runtime-core goals defined by this
RFC:

- Completed
  - posture metadata has been integrated into tool governance
  - `tool-gate` now provides a shared invocation skeleton plus posture policy
  - `ExplorationSupervisor` and `TaskWatchdogService` have been split out
  - scan convergence for `observe` posture has been changed from hard block to
    advisory
  - `context-composer` now includes a governance injection cap
  - `commitment` posture now runs through
    `effect_commitment -> proposal admission -> authorization -> receipt`
  - `capability-view` now exposes posture and effect boundaries
  - `reversible_mutate` now has independent receipts and journal anchors
    - `workspace_write` reuses patchsets as rollback artifacts
    - `task_*` memory mutation records task-state journals
    - `cognition_note` records artifact receipts
  - `reversible_mutate` now has an explicit rollback execution surface
    - `runtime.tools.rollbackLastMutation(...)` can roll back the latest
      reversible receipt
    - workspace patchsets and task-state journals now share the same rollback
      API
  - trust now incorporates verification and rollback cleanliness
  - `commitment` posture now has a session-local operator approval desk
    - `runtime.proposals.listPendingEffectCommitments(...)`
    - `runtime.proposals.decideEffectCommitment(...)`
    - `runtime.tools.start(..., effectCommitmentRequestId)` resumes a concrete
      pending request that was explicitly approved
    - approval-desk state is replay-hydrated from tape events after restart
      instead of depending on process-local memory
- Constraint notes
  - hosted surfaces may still explicitly provide a `governancePort`, for
    example a `trusted-local` host policy
  - as a result, whether immediate human or explicit approval is required is
    now a host-policy choice rather than a runtime-core gap
