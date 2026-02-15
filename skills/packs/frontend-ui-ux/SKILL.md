---
name: frontend-ui-ux
description: High-intent frontend design and implementation workflow for bold, coherent, production-ready UI.
version: 1.0.0
stability: stable
tier: pack
tags: [frontend, ui, ux, design, motion]
anti_tags: [backend, api-only]
tools:
  required: [read]
  optional: [look_at, lsp_diagnostics, ast_grep_search, skill_complete]
  denied: []
budget:
  max_tool_calls: 60
  max_tokens: 130000
outputs: [design_direction, ui_changes, interaction_checks]
consumes: [execution_steps, component_changes]
escalation_path:
  design_system_conflict: planning
---

# Frontend UI/UX Pack Skill

## Intent
Deliver visually intentional, context-aware interfaces that are functional, testable, and memorable.

## Trigger
Use this pack when user requests:
- new UI surfaces or major visual refresh
- interaction redesign
- stronger aesthetic direction beyond routine styling

## Design Workflow

### Step 1: Commit to a design direction (mandatory)
Pick one explicit aesthetic direction before coding:
- brutally minimal
- editorial/magazine
- industrial/utilitarian
- retro-futuristic
- playful/toy-like
- luxury/refined
- brutalist/raw

Blocking output:
```text
DESIGN_DIRECTION
- direction: "<chosen style>"
- product_goal: "<what this UI must achieve>"
- differentiation: "<one memorable quality>"
```

### Step 2: Define constraints and boundaries
Capture:
- framework and existing design system constraints
- accessibility baseline
- responsive breakpoints
- performance constraints (animation/render budgets)

### Step 3: Compose visual system
Define and apply:
- typography pairing (display + body)
- color tokens (dominant, support, accent)
- spacing/grid rhythm
- interaction motion hierarchy

Rules:
- use CSS variables/tokens for palette and spacing
- use intentional contrast, not random saturation
- reserve high-motion effects for key transitions

### Step 4: Implement interaction model
For each primary interaction:
- define initial state
- define user action
- define visible feedback
- define loading/error/empty behavior

Ensure keyboard and screen-reader pathways remain valid.

### Step 5: Verify UI quality
Minimum checks:
- desktop/mobile responsiveness
- interaction correctness
- visual consistency with chosen direction
- accessibility baseline (focus visibility, semantic controls)

Output:
```text
INTERACTION_CHECKS
- scenario: "<user action>"
  expected: "<visible outcome>"
  status: <pass|fail|pending>
```

## Aesthetic Guardrails

### Typography
- Avoid generic defaults when task asks for strong visual identity.
- Keep hierarchy clear: display, heading, body, caption roles.

### Color
- Build coherent palettes with explicit token naming.
- Avoid low-contrast text and muddy gradients.

### Motion
- Prefer meaningful transitions tied to user intent.
- Avoid stacking multiple independent micro-animations without hierarchy.

### Layout
- Balance rhythm, whitespace, and focal hierarchy.
- Break rigid symmetry only when intentional and controlled.

## Anti-Patterns (never)
- Defaulting to generic UI patterns without explicit direction.
- Mixing multiple conflicting visual styles in one surface.
- Decorative motion that harms readability or task completion.
- Ignoring mobile behavior when changing layout structure.
- Sacrificing accessibility for visual novelty.

## Stop Conditions
- Product/design constraints are missing and direction cannot be chosen safely.
- Existing design system forbids requested visual changes.
- Required assets (fonts/brand tokens) are unavailable.

When blocked, report exact missing constraints or assets.

## Example

Input:
```text
"Design and implement a pricing hero that feels editorial and premium."
```

Expected workflow:
1. emit `DESIGN_DIRECTION` (`editorial/magazine`).
2. define typography and color tokens.
3. implement layout with clear focal hierarchy and measured motion.
4. return `INTERACTION_CHECKS` and responsive verification notes.
