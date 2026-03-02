---
name: cartography
description: Use when needing module dependency orientation, ownership discovery, or impact analysis before changes.
version: 1.0.0
stability: stable
tier: base
tags: [map, architecture, modules, dependency]
anti_tags: [quick-fix]
tools:
  required: [grep, read]
  optional: [glob, ledger_query, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 55
  max_tokens: 120000
outputs: [tree_summary, dependency_hotspots, ownership_hints, map_confidence]
consumes: []
escalation_path:
  structure_unclear: exploration
---

# Cartography Skill

## Intent

Produce a reusable structural map that supports exploration, planning, and onboarding.

## Trigger

Use this skill when the user needs:

- module dependency orientation
- ownership or boundary discovery
- impact analysis before changes

## Mapping Workflow

### Step 1: Build top-level tree summary

Map the repository by major zones:

- entrypoints (`cli`, `app`, `service`, `runtime`)
- domain logic
- adapters/integrations
- test and tooling directories

Output:

```text
TREE_SUMMARY
- zone: "<name>"
  purpose: "<role>"
  key_paths:
    - <path>
```

### Step 2: Extract dependency hotspots

Identify modules with:

- high fan-in (many callers)
- high fan-out (many dependencies)
- boundary crossing responsibilities

Hotspot template:

```text
DEPENDENCY_HOTSPOT
- module: <path-or-symbol>
- fan_in: <low|medium|high>
- fan_out: <low|medium|high>
- risk_reason: "<why this matters>"
```

### Step 3: Infer ownership hints

Use naming, directory conventions, and test proximity to infer:

- module ownership domain
- shared utility vs feature-specific code
- likely review stakeholders

Output:

```text
OWNERSHIP_HINT
- area: <path>
- probable_owner_scope: "<team/domain>"
- confidence: <low|medium|high>
```

### Step 4: Highlight critical pathways

For target request, map at least one end-to-end path:
`input -> transformation -> side effect/output`

If multiple pathways exist, provide the primary one and mention alternates.

### Step 5: Emit confidence and unknowns

```text
MAP_CONFIDENCE
- confidence: <low|medium|high>
- unknowns:
  - "<missing linkage>"
  - "<missing ownership>"
```

## Heuristics

- Prioritize active code over deprecated/legacy folders.
- Use test files to confirm intended module boundaries.
- Prefer import graph signals over file size when ranking hotspots.

## Executable Evidence Bridge

This is a read-only mapping skill. If confidence is low due missing generated artifacts, scripts, or external metadata,
emit `TOOL_BRIDGE` using `skills/base/planning/references/executable-evidence-bridge.md` so a human can run a deterministic
collector and feed results back.

## Stop Conditions

- Repository lacks enough structure to infer boundaries.
- Generated code dominates and source ownership is unclear.
- Request scope spans external systems not present locally.

## Anti-Patterns (never)

- Dumping directory listings without interpretation.
- Treating every module as equally important.
- Ignoring dependency direction when naming hotspots.
- Claiming ownership certainty without evidence.

## Example

Input:

```text
"Map the runtime-to-extension-to-tools flow and identify high-risk coupling points."
```

Expected output:

1. `TREE_SUMMARY` of runtime, extensions, tools, tests.
2. `DEPENDENCY_HOTSPOT` list for coupling points.
3. `OWNERSHIP_HINT` and `MAP_CONFIDENCE` with unknowns.
