---
name: bun
description: Bun runtime and tooling conventions for scripts, tests, and package workflows.
version: 1.0.0
stability: stable
tier: pack
tags: [bun, runtime, test, scripts]
anti_tags: [npm-only]
tools:
  required: [exec]
  optional: [read, lsp_diagnostics, skill_complete]
  denied: []
budget:
  max_tool_calls: 35
  max_tokens: 80000
outputs: [bun_commands_run, environment_notes]
consumes: []
escalation_path: {}
---

# Bun Pack Skill

## Intent

Use Bun-native workflows consistently for install, build, test, and script execution.

## Trigger

Use this pack when project runtime or package tooling is Bun-based.

## Core Rules

- Prefer `bun` commands over `npm`/`yarn` equivalents.
- Keep script invocations deterministic and workspace-aware.
- Match repository script names from `package.json` instead of inventing commands.

## Command Conventions

### Install and dependency operations

```bash
bun install
```

### Run package scripts

```bash
bun run <script-name>
```

### Run tests

```bash
bun test
bun test <target>
```

### Execute TypeScript/JavaScript files

```bash
bun run <file.ts>
```

## Workflow

### Step 1: Discover available scripts

Inspect root and relevant package manifests before running commands.

### Step 2: Pick smallest useful command

- local verification: targeted script/test first
- broader confidence: full script/test suite second

### Step 3: Record environment notes

Report environment caveats when commands depend on:

- missing `.env` variables
- unavailable external services
- workspace/package filters

## Stop Conditions

- Repository is not Bun-based and no Bun workflow is configured.
- Required script is absent and there is no documented equivalent.
- Command execution depends on unavailable environment or service.

## Anti-Patterns (never)

- Using `npm` commands in Bun-first repos without explicit reason.
- Running heavyweight full suites before targeted validation.
- Assuming script names (`test`, `build`) without checking manifests.
- Hiding command failures behind generic summaries.

## Example

Input:

```text
"Validate TypeScript changes in this Bun monorepo."
```

Expected sequence:

1. inspect script names in package manifests.
2. run `bun run typecheck` (or repo-specific equivalent).
3. run targeted and then broader tests as needed.
4. report `bun_commands_run` with evidence and caveats.
