---
name: react
description: React component, state, and rendering patterns with maintainable structure.
version: 1.0.0
stability: stable
tier: pack
tags: [react, frontend, hooks, ui]
anti_tags: [backend]
tools:
  required: [read]
  optional: [lsp_diagnostics, ast_grep_search, look_at, skill_complete]
  denied: []
budget:
  max_tool_calls: 45
  max_tokens: 100000
outputs: [component_changes, interaction_checks]
consumes: [execution_steps]
escalation_path:
  missing_test_harness: exploration
---

# React Pack Skill

## Intent
Implement React UI changes with clear component boundaries, predictable state flow, and verifiable behavior.

## Trigger
Use this pack when editing React components, hooks, UI state, or interaction flows.

## Core Rules
- Keep container/presentational boundaries explicit.
- Co-locate state with the smallest component that owns it.
- Keep effects deterministic and dependency-complete.
- Prefer derived state over duplicated state.

## Workflow

### Step 1: Identify interaction contract
For each changed component, define:
- props contract
- state owner
- user interactions and expected outcomes

### Step 2: Apply component-level changes
Preferred patterns:
- controlled inputs for forms
- memoization only when measurable rerender pressure exists
- event handlers named by intent (`handleSubmit`, `handleToggle`)
- accessibility attributes for interactive elements

Avoid:
- deep prop drilling when composition/context is simpler
- side effects in render path
- broad `useEffect` usage for purely synchronous derivations

### Step 3: Verify behavior
Check at minimum:
- initial render matches expected UI state
- key interaction path updates state and UI correctly
- loading/error/empty states are handled intentionally

Suggested command pattern:
```bash
bun test <react-related-target>
```

## Design Guardrails
- Respect existing design system tokens and spacing scale.
- Avoid introducing ad-hoc style patterns inconsistent with current codebase.
- Use the dedicated `frontend-ui-ux` pack when task explicitly asks for major visual direction changes.

## Stop Conditions
- Component behavior cannot be validated due to missing runtime/test harness.
- Requested visual changes conflict with mandatory design-system constraints.
- Required props/data contracts are unknown and change core interaction behavior.

## Anti-Patterns (never)
- Monolithic components mixing data fetching, heavy state, and rendering.
- Effect chains that emulate imperative lifecycle logic.
- Conditional hook calls or unstable dependency arrays.
- UI-only fixes that break keyboard/accessibility paths.

## Example

Input:
```text
"Fix stale state update in settings form and keep UI feedback accurate."
```

Expected output:
1. tighten state ownership and update handler flow.
2. ensure effect dependencies are explicit.
3. report interaction checks and test evidence.
