# Orchestration

Orchestration is driven by runtime state management plus extension lifecycle handlers.

- Runtime state machine: `packages/roaster-runtime/src/runtime.ts`
- Extension registration: `packages/roaster-extensions/src/index.ts`

## Main Execution Sequence

1. CLI creates a session (`packages/roaster-cli/src/session.ts`)
2. Extensions are registered (`packages/roaster-extensions/src/index.ts`)
3. `before_agent_start` injects context contract + tape status + replay context
4. `tool_call` passes quality and budget gates
5. `tool_result` updates ledger, events, and verification evidence
6. `agent_end` runs completion guard checks and notification hooks

## Runtime Subsystems

- Skills: `packages/roaster-runtime/src/skills/registry.ts`
- Verification: `packages/roaster-runtime/src/verification/gate.ts`
- Ledger: `packages/roaster-runtime/src/ledger/evidence-ledger.ts`
- Context budget: `packages/roaster-runtime/src/context/budget.ts`
- Event store: `packages/roaster-runtime/src/events/store.ts`
- Tape replay engine: `packages/roaster-runtime/src/tape/replay-engine.ts`
- Cost tracker: `packages/roaster-runtime/src/cost/tracker.ts`
