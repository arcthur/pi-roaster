# Troubleshooting: Common Failures

Start with `brewva inspect` for any persisted-session issue. It rebuilds the
authoritative replay state first, then reports which derived layer is stale or
inconsistent.

## `skill_complete` Is Rejected

- Cause: missing required outputs or missing verification evidence.
- Check: `brewva inspect --session <id>` for latest verification outcome and active skill output requirements.
- Action: provide all required outputs and run required verification checks.

## `tool_call` Is Blocked

- Cause: denied effects on the active contract, effect-authorization enforcement, token/tool-call budget enforcement, or cost budget violation.
- Check: `brewva inspect --session <id>` for active skill, cost summary, and latest verification/task state.
- Action: switch active skill, adjust `security.mode` (`permissive`/`standard`/`strict`) to change effective enforcement strategy, or resolve budget policy constraints.

## `--replay` Returns No Session

- Cause: no persisted event file for any session.
- Check: `brewva inspect` to confirm whether any replayable session exists for the current workspace.
- Action: run at least one normal session to generate event artifacts.

## `--undo` Has No Recoverable Patch

- Cause: no tracked mutation exists in the target session.
- Check: `brewva inspect --session <id>` for rollback snapshot availability and recent mutation history.
- Action: ensure edits occur through tracked tool paths and retry.

## Workspace Scan Is Slow Or Incomplete

- Cause: parallel read scans are forced to sequential mode, scan includes too many files, or files are intermittently unreadable.
- Check:
  - `packages/brewva-tools/src/utils/parallel-read.ts`
  - `packages/brewva-tools/src/lsp.ts`
  - `packages/brewva-tools/src/ast-grep.ts`
  - `docs/reference/events.md` (`tool_parallel_read`)
- Action:
  - Start with `brewva inspect --session <id>` to confirm tape/projection health, then inspect session events for `tool_parallel_read` payloads.
  - If `mode=sequential` with `reason=parallel_disabled`, enable runtime `parallel.enabled`.
  - If `failedFiles` is consistently high, verify file permissions and path stability.
  - If `durationMs` and `batches` are high for large scans, tune `parallel.maxConcurrent`.
  - Note: per-session total parallel starts are currently capped by an internal runtime constant (`PARALLEL_MAX_TOTAL_PER_SESSION=10`), not by public config.
