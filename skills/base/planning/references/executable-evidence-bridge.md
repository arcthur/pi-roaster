# Executable Evidence Bridge

## Intent

Use executable evidence as the default proof model. Prefer reproducible commands over narrative claims.

## Priority

1. `COMMAND_EVIDENCE`: run concrete commands and capture pass/fail signals.
2. `TOOL_BRIDGE`: if commands cannot verify the target, provide a reusable `bash`/`python` tool spec for human execution.
3. `MISSING_INPUT`: only request input when both command execution and tool bridging are blocked.

## Skill-Type Adaptation

- **Execution-oriented skills** (`debugging`, `verification`, `patching`, `git`, `agent-browser`, `bun`):
  - command execution is mandatory before conclusions.
  - fallback is `TOOL_BRIDGE` when execution is blocked.
- **Read-only analysis skills** (`review`, `planning`, `compose`, `exploration`, `cartography`):
  - use command-backed evidence when available.
  - do not edit files directly; emit `TOOL_BRIDGE` handoff when proof requires executable tooling.
- **Project orchestration skills** (`brewva-project`):
  - enforce executable evidence across workstreams.
  - produce `TOOL_BRIDGE` for blocked critical checks.

## `TOOL_BRIDGE` Template

```text
TOOL_BRIDGE
- purpose: "<what this script verifies or reproduces>"
- language: <bash|python>
- script_path: "<repo-relative path>"
- inputs:
  - "<arg/env>"
- outputs:
  - "<artifact/log/report>"
- run_command: "<exact command>"
- success_criteria:
  - "<observable pass signal>"
- failure_criteria:
  - "<observable fail signal>"
- owner_handoff: "<skill/user who should execute it>"
```

## Contract Note

In Brewva, `outputs:` in skill frontmatter is a **required** contract enforced by `skill_complete`.
Do not add `tool_bridge` to `outputs:` unless you want it required on every completion.

`TOOL_BRIDGE` should be treated as:

- a section in the skill's narrative report, and/or
- an extra output key provided to `skill_complete` (allowed, but not required by contract).

## Language Selection

- Prefer `bash` for command orchestration, wrappers, and lightweight environment checks.
- Prefer `python` for parsing logs, data validation, protocol checks, or structured report generation.

## Quality Bar

- The command or script must be deterministic enough to rerun.
- Success/failure criteria must be observable from output or artifacts.
- Avoid "manual inspection only" unless no automation path exists.
- If automation is impossible, explain the exact blocker and the minimum missing prerequisite.
