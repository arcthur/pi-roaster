---
name: repository-analysis
description: Build a reliable repository snapshot, module boundary map, and impact analysis before design, debugging, or review.
stability: stable
effect_level: read_only
tools:
  required: [read, grep]
  optional: [glob, lsp_symbols, lsp_find_references, ledger_query, skill_complete]
  denied: [write, edit, exec, process]
budget:
  max_tool_calls: 80
  max_tokens: 160000
outputs: [repository_snapshot, impact_map, unknowns]
output_contracts:
  repository_snapshot:
    kind: informative_text
    min_words: 3
    min_length: 18
  impact_map:
    kind: informative_text
    min_words: 3
    min_length: 18
  unknowns:
    kind: one_of
    variants:
      - kind: informative_text
        min_words: 2
        min_length: 12
      - kind: informative_list
        min_items: 1
        allow_objects: true
        min_words: 2
        min_length: 12
consumes: []
requires: []
---

# Repository Analysis Skill

## Intent

Build a path-grounded understanding of the codebase that downstream skills can reuse.

## Trigger

Use this skill when:

- the repository or module boundary is unfamiliar
- a task needs impact analysis before implementation
- debugging or review requires structural context

## Workflow

### Step 1: Map the active surface

Identify entrypoints, main packages, ownership boundaries, and the hot path relevant to the request.

### Step 2: Build the reusable snapshot

Produce:

- `repository_snapshot`: main zones, responsibilities, and key paths
- `impact_map`: likely affected files, boundaries, and high-risk touchpoints
- `unknowns`: gaps that still block confident action

### Step 3: Stop broad scanning

Once the hot path and boundary map are clear, stop expanding and hand off.

## Stop Conditions

- entrypoints cannot be identified from the local repo
- generated or external code hides the real ownership boundary
- the request depends on systems not present in the workspace

## Anti-Patterns

- reading random files without a hypothesis
- dumping directory trees without explaining why they matter
- confusing file count with architectural importance

## Example

Input: "Map the runtime-to-gateway-to-cli path and identify high-risk coupling points."

Output: `repository_snapshot`, `impact_map`, `unknowns`.
