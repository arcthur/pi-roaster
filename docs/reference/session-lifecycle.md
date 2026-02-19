# Reference: Session Lifecycle

## Lifecycle Stages

1. Parse CLI args and resolve mode/input (`packages/brewva-cli/src/index.ts`)
2. Create session + runtime (`packages/brewva-cli/src/session.ts`)
3. Register extension handlers (`packages/brewva-extensions/src/index.ts`)
4. Run turn loop with tool execution, ledger/event writes, and verification updates
5. Emit replayable event timeline and dispose session resources

## Mode-Specific Paths

- Replay (`--replay`): query structured events and print text/JSON timeline
- Undo (`--undo`): resolve target session and rollback latest tracked patch set
- JSON one-shot (`--mode json`/`--json`): emits normal stream plus final `brewva_event_bundle`

## Recovery Path

- On `SIGINT`/`SIGTERM`, CLI records `session_interrupted`, waits for agent idle (bounded by graceful timeout), then exits.
- Next startup reconstructs foldable runtime state from event tape (`checkpoint + delta` replay).
