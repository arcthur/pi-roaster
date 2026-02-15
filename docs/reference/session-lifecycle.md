# Reference: Session Lifecycle

## Lifecycle Stages

1. Session creation (`packages/roaster-cli/src/session.ts`)
2. Runtime bootstrap (`packages/roaster-runtime/src/runtime.ts`)
3. Optional startup restore (`restoreStartupSession`)
4. Turn loop with tool execution and evidence capture
5. Verification and completion evaluation
6. Snapshot persistence on shutdown or signal

## Recovery Path

- Persist snapshot: `persistSessionSnapshot`
- Explicit restore: `restoreSessionSnapshot`
- Startup restore: `restoreStartupSession`
- Event replay: `queryStructuredEvents` and CLI `--replay`
