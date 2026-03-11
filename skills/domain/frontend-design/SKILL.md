---
name: frontend-design
description: Shape UI direction, interaction structure, and visual intent for frontend work that needs taste and product judgment.
stability: stable
effect_level: read_only
tools:
  required: [read]
  optional: [look_at, grep, skill_complete]
  denied: [write, edit, exec, process]
budget:
  max_tool_calls: 70
  max_tokens: 140000
references:
  - references/bento-paradigm.md
  - references/creative-arsenal.md
outputs: [ui_direction, ui_spec]
output_contracts:
  ui_direction:
    kind: informative_text
    min_words: 3
    min_length: 18
  ui_spec:
    kind: informative_text
    min_words: 4
    min_length: 24
consumes: [design_spec, browser_observations]
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
