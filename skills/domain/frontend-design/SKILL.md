---
name: frontend-design
description: Shape UI direction, interaction structure, and visual intent for frontend
  work that needs taste and product judgment.
stability: stable
intent:
  outputs:
    - ui_direction
    - ui_spec
  output_contracts:
    ui_direction:
      kind: text
      min_words: 3
      min_length: 18
    ui_spec:
      kind: text
      min_words: 4
      min_length: 24
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
  fallback_tools:
    - look_at
    - grep
    - skill_complete
references:
  - references/bento-paradigm.md
  - references/creative-arsenal.md
consumes:
  - design_spec
  - browser_observations
requires: []
---

# Frontend Design Skill

## Intent

Turn product intent into a clear UI direction that implementation can execute without generic drift.

## Trigger

Use this skill when:

- a frontend feature needs visual or interaction design
- existing UI needs stronger hierarchy, clarity, or personality
- implementation needs a UI-specific spec instead of generic prose

## Workflow

### Step 1: Read the product context

Identify user goal, surface, and design system constraints.

### Step 2: Choose a visual and interaction direction

Define hierarchy, state changes, and layout behavior.

### Step 3: Emit design artifacts

Produce:

- `ui_direction`: visual thesis and interaction posture
- `ui_spec`: structure, state behavior, and implementation-critical details

## Stop Conditions

- the request is pure implementation with no design ambiguity
- the surface already has a locked design system answer
- the real blocker is missing product or repository context

## Anti-Patterns

- defaulting to generic UI patterns with no point of view
- describing aesthetics without state behavior
- ignoring existing product language when working inside an established surface

## Example

Input: "Define the v2 catalog page UI for skills taxonomy and routing profiles."

Output: `ui_direction`, `ui_spec`.
