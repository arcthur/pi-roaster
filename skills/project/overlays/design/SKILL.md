---
intent:
  outputs:
    - design_spec
    - execution_plan
    - execution_mode_hint
    - risk_register
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - glob
    - lsp_symbols
    - ledger_query
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/migration-priority-matrix.md
consumes:
  - root_cause
  - runtime_trace
requires:
  - repository_snapshot
  - impact_map
---

# Brewva Design Overlay

## Intent

Force design decisions to respect Brewva's governance-kernel boundary and migration priorities.

## Trigger

Use this overlay when designing changes inside Brewva.

## Workflow

### Step 1: Check boundary ownership

Decide whether a concern belongs in runtime, tools, extensions, CLI, or gateway before proposing code movement.

### Step 2: Bias toward kernel clarity

Prefer moving lifecycle choreography out of public skills and into runtime or control-plane semantics when the boundary is procedural rather than capability-based.

## Stop Conditions

- the change is purely local and does not touch ownership boundaries
- required package ownership is still uncertain

## Anti-Patterns

- pushing agent intelligence into the runtime kernel for convenience
- growing project-specific super-skills instead of overlays

## Example

Input: "Redesign the public skill taxonomy without reintroducing pack filtering."
