# Invariants And Reliability

This document captures runtime invariants that must remain true for safety, recoverability, and observability.

## Invariant Set

## 1) Evidence Integrity Invariant

- Every persisted tool outcome must produce a ledger entry or an explicit failure record.
- Ledger chain verification must remain valid for each session.

Relevant implementation:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/ledger/evidence-ledger.ts`

## 2) Event Observability Invariant

- Major lifecycle events (session, turn, tool, context, verification, cost) must be queryable via event store.
- Replay output must be derivable from persisted events only.

Relevant implementation:

- `packages/brewva-runtime/src/events/store.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-cli/src/index.ts`

## 3) Recovery Consistency Invariant

- Runtime recovery state must be derivable from persisted event tape only
  (checkpoint + delta replay).
- Process restart must not require opaque runtime snapshot blobs.

Relevant implementation:

- `packages/brewva-runtime/src/tape/replay-engine.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 4) Contract Enforcement Invariant

- Tool execution must respect active skill tool policy and budget policy before execution.
- Skill completion must enforce required outputs and verification checks.

Relevant implementation:

- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-tools/src/skill-complete.ts`

## 5) Rollback Safety Invariant

- Rollback must restore only tracked mutations for the target session.
- After successful rollback, verification state must be reset to avoid stale pass assumptions.

Relevant implementation:

- `packages/brewva-runtime/src/state/file-change-tracker.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 6) Budget Boundedness Invariant

- Context injection must remain bounded by context budget policy.
- Cost summary and budget alerts must reflect session-level and skill-level usage.

Relevant implementation:

- `packages/brewva-runtime/src/context/budget.ts`
- `packages/brewva-runtime/src/cost/tracker.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 7) Profile Transparency Invariant

- Extension-enabled and `--no-extensions` profiles must be behaviorally explicit:
  reduced profile may bypass extension hooks, but this must be deliberate and
  observable.
- When extensions are disabled, core lifecycle and assistant-usage telemetry
  must still be persisted.

Relevant implementation:

- `packages/brewva-cli/src/session.ts`
- `packages/brewva-cli/src/session-event-bridge.ts`
- `packages/brewva-extensions/src/index.ts`

## Failure Modes and Containment

- Missing verification evidence: gate must block completion.
- Missing rollback state: return explicit `no_patchset`.
- Replay without events: return explicit no-session condition.
- Context hard-limit breach: drop injection and emit context drop event.

## Reliability Validation

- Runtime behavior tests: `test/runtime/runtime.test.ts`
- End-to-end tool flow tests: `test/runtime/tools-flow.test.ts`
- Gap remediation tests: `test/runtime/gap-remediation.test.ts`
- Extension reliability tests: `test/extensions/extension-gaps.test.ts`
