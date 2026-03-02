---
name: exploration
description: Use when repository is unfamiliar, request references unknown modules, or design decision needs structural context — before planning or patching.
version: 1.0.0
stability: stable
tier: base
tags: [explore, understand, map, discover]
anti_tags: [apply-change]
tools:
  required: [read, grep]
  optional: [glob, ledger_query, look_at, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 60
  max_tokens: 130000
outputs: [architecture_map, key_modules, unknowns]
consumes: [tree_summary]
escalation_path:
  entrypoint_not_found: cartography
---

# Exploration Skill

## Intent

Build a reliable mental model before planning or patching.

## Trigger

Use this skill when:

- repository is unfamiliar
- request references unknown modules
- design decision needs structural context

## Exploration Workflow

### Step 1: Entry-point scan (breadth first)

Start from top-level anchors:

1. runtime/package manifests
2. app entrypoints
3. build/test config
4. major module directories

Suggested command sequence:

```bash
rg --files
```

Then inspect key anchors with `read`.

### Step 2: Build dependency map

Identify:

- upstream inputs (APIs, config, events)
- core transforms (services, domain logic)
- downstream outputs (CLI, HTTP, files, external tools)

Capture module edges in concise form:

```text
MODULE_EDGE
- from: <module>
- to: <module>
- reason: "<import/call/data flow>"
```

### Step 3: Locate critical paths

Find the hot path for the user request:

- request entry
- primary decision logic
- persistence or side-effect boundary

Read deeply only in 2-4 critical files first.

### Step 4: Control exploration depth

Depth limits:

- initial scan: up to 50 files
- deep dive: only files tied to hot path
- stop broad scanning when repeated patterns emerge

If context remains unclear, list specific unknowns and continue focused search.

### Step 5: Emit exploration outputs

```text
ARCHITECTURE_MAP
- entrypoints:
  - <path>
- key_modules:
  - <module + role>
- data_flow:
  - "<A -> B -> C>"

UNKNOWNS
- "<unknown item>"
- "<unknown item>"
```

## Heuristics

- Prefer current implementation paths over legacy/dead code.
- Use test files to infer expected behavior quickly.
- Track naming conventions to infer boundary ownership.
- Prioritize modules with high fan-in or fan-out.

## Executable Evidence Bridge

Prefer reproducible command traces over narrative-only assumptions. If exploration depends on unavailable runtime data
or generated outputs, emit `TOOL_BRIDGE` using `skills/base/planning/references/executable-evidence-bridge.md`.

## Stop Conditions

- Cannot identify real entrypoint after focused scan.
- Request depends on generated/external code not present locally.
- Tool-call budget exhausted without converging map.

## Anti-Patterns (never)

- Reading random files without hypothesis.
- Deep-diving implementation before mapping boundaries.
- Producing generic architecture summary not tied to paths.
- Scanning entire repository for a local bugfix task.

## Example

Input:

```text
"Understand how verification state flows from tool results to final gate decision."
```

Expected flow:

1. Locate extension entrypoints.
2. Trace evidence ingestion path.
3. Trace gate evaluation path.
4. Return `ARCHITECTURE_MAP` and unresolved unknowns.
