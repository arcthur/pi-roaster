# Troubleshooting: Common Failures

## `skill_complete` Is Rejected

- Cause: missing required outputs or missing verification evidence.
- Check: `packages/brewva-tools/src/skill-complete.ts`
- Action: provide all required outputs and run required verification checks.

## `tool_call` Is Blocked

- Cause: denied tool by active contract, allowlist enforcement, token budget enforcement, or cost budget violation.
- Check: `packages/brewva-runtime/src/runtime.ts`
- Action: switch active skill, adjust `security.allowedToolsMode` / `security.skillMaxTokensMode`, or resolve budget policy constraints.

## `--replay` Returns No Session

- Cause: no persisted event file for any session.
- Check: `packages/brewva-runtime/src/events/store.ts`
- Action: run at least one normal session to generate event artifacts.

## `--undo` Has No Recoverable Patch

- Cause: no tracked mutation exists in the target session.
- Check: `packages/brewva-runtime/src/state/file-change-tracker.ts`
- Action: ensure edits occur through tracked tool paths and retry.

## Workspace Scan Is Slow Or Incomplete

- Cause: parallel read scans are forced to sequential mode, scan includes too many files, or files are intermittently unreadable.
- Check:
  - `packages/brewva-tools/src/utils/parallel-read.ts`
  - `packages/brewva-tools/src/lsp.ts`
  - `packages/brewva-tools/src/ast-grep.ts`
  - `docs/reference/events.md` (`tool_parallel_read`)
- Action:
  - Inspect session events and locate `tool_parallel_read` payloads.
  - If `mode=sequential` with `reason=parallel_disabled`, enable runtime `parallel.enabled`.
  - If `failedFiles` is consistently high, verify file permissions and path stability.
  - If `durationMs` and `batches` are high for large scans, tune `parallel.maxConcurrent` and `parallel.maxTotal`.
