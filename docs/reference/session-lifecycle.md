# Reference: Session Lifecycle

## Lifecycle Stages

1. Session creation (`packages/roaster-cli/src/session.ts`)
2. Runtime bootstrap (`packages/roaster-runtime/src/runtime.ts`)
3. Turn loop with tool execution and evidence capture
4. Verification and completion evaluation
5. Event persistence for replay/audit

## Recovery Path

- Event replay: `queryStructuredEvents` and CLI `--replay`
