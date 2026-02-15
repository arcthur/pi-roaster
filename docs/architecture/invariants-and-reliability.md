# Invariants And Reliability

This document captures runtime invariants that must remain true for safety, recoverability, and observability.

## Invariant Set

## 1) Evidence Integrity Invariant

- Every persisted tool outcome must produce a ledger entry or an explicit failure record.
- Ledger chain verification must remain valid for each session.

Relevant implementation:

- `packages/roaster-runtime/src/runtime.ts`
- `packages/roaster-runtime/src/ledger/evidence-ledger.ts`

## 2) Event Observability Invariant

- Major lifecycle events (session, turn, tool, context, verification, cost) must be queryable via event store.
- Replay output must be derivable from persisted events only.

Relevant implementation:

- `packages/roaster-runtime/src/events/store.ts`
- `packages/roaster-runtime/src/runtime.ts`
- `packages/roaster-cli/src/index.ts`

## 3) Recovery Consistency Invariant

- Snapshot restore must rehydrate active skill state, counters, verification state, and parallel budget state.
- Startup restore must not silently drop interruption context when recoverable snapshot exists.

Relevant implementation:

- `packages/roaster-runtime/src/state/snapshot-store.ts`
- `packages/roaster-runtime/src/runtime.ts`

## 4) Contract Enforcement Invariant

- Tool execution must respect active skill tool policy and budget policy before execution.
- Skill completion must enforce required outputs and verification checks.

Relevant implementation:

- `packages/roaster-runtime/src/security/tool-policy.ts`
- `packages/roaster-runtime/src/runtime.ts`
- `packages/roaster-tools/src/skill-complete.ts`

## 5) Rollback Safety Invariant

- Rollback must restore only tracked mutations for the target session.
- After successful rollback, verification state must be reset to avoid stale pass assumptions.

Relevant implementation:

- `packages/roaster-runtime/src/state/file-change-tracker.ts`
- `packages/roaster-runtime/src/runtime.ts`

## 6) Budget Boundedness Invariant

- Context injection must remain bounded by context budget policy.
- Cost summary and budget alerts must reflect session-level and skill-level usage.

Relevant implementation:

- `packages/roaster-runtime/src/context/budget.ts`
- `packages/roaster-runtime/src/cost/tracker.ts`
- `packages/roaster-runtime/src/runtime.ts`

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
