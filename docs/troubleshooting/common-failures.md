# Troubleshooting: Common Failures

## `skill_complete` Is Rejected

- Cause: missing required outputs or missing verification evidence.
- Check: `packages/roaster-tools/src/skill-complete.ts`
- Action: provide all required outputs and run required verification checks.

## `tool_call` Is Blocked

- Cause: denied tool by active contract, allowlist enforcement, token budget enforcement, or cost budget violation.
- Check: `packages/roaster-runtime/src/runtime.ts`
- Action: switch active skill, adjust `security.allowedToolsMode` / `security.skillMaxTokensMode`, or resolve budget policy constraints.

## `--replay` Returns No Session

- Cause: no persisted event file for any session.
- Check: `packages/roaster-runtime/src/events/store.ts`
- Action: run at least one normal session to generate event artifacts.

## `--undo` Has No Recoverable Patch

- Cause: no tracked mutation exists in the target session.
- Check: `packages/roaster-runtime/src/state/file-change-tracker.ts`
- Action: ensure edits occur through tracked tool paths and retry.
