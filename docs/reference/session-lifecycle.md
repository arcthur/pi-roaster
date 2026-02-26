# Reference: Session Lifecycle

## Lifecycle Stages

1. Parse CLI args and resolve mode/input (`packages/brewva-cli/src/index.ts`)
2. Create session + runtime (`packages/brewva-cli/src/session.ts`)
   - runtime config is loaded/normalized first
   - startup UI setting (`ui.quietStartup`) is applied from `runtime.config.ui` into session settings overrides
3. Register lifecycle handlers (profile-dependent)
   - extensions-enabled: full extension stack from `packages/brewva-extensions/src/index.ts`
   - `--no-extensions`: runtime core bridge + session event bridge (`packages/brewva-extensions/src/runtime-core-bridge.ts`, `packages/brewva-cli/src/session-event-bridge.ts`)
4. Run turn loop with tool execution, ledger/event writes, and verification updates
5. Emit replayable event timeline and dispose session resources

## Mode-Specific Paths

- Replay (`--replay`): query structured events and print text/JSON timeline
- Undo (`--undo`): resolve target session and rollback latest tracked patch set
- JSON one-shot (`--mode json`/`--json`): emits normal stream plus final `brewva_event_bundle`
- `--no-extensions`: keeps runtime-core safety/evidence hooks plus minimal core context status injection, while extension presentation hooks remain disabled
- Channel gateway (`--channel`): run adapter bridge loop; bind channel conversations to agent sessions and dispatch inbound turns serially per conversation key

## Recovery Path

- On `SIGINT`/`SIGTERM`, CLI records `session_interrupted`, waits for agent idle (bounded by graceful timeout), then exits.
- Next startup reconstructs foldable replay state from event tape (`checkpoint + delta` replay),
  including task/truth/cost/evidence/memory fold slices.
- First `onTurnStart()` hydrates session-local runtime state from tape events
  (skill/budget/cost counters, warning dedupe, ledger compaction cooldown).
- If memory projection artifacts are missing, runtime can rebuild memory
  projection files from tape-backed `memory_*` snapshots.
