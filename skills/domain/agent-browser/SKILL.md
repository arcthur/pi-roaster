---
name: agent-browser
description: Use browser automation to inspect pages, gather evidence, and validate flows that cannot be trusted from static code alone.
stability: stable
effect_level: execute
tools:
  required: [read, exec]
  optional: [look_at, grep, skill_complete]
  denied: []
budget:
  max_tool_calls: 80
  max_tokens: 140000
references:
  - references/diff-verification.md
  - references/eval-safe-mode.md
  - references/security-baseline.md
  - references/semantic-locators.md
scripts:
  - templates/authenticated-session.sh
  - templates/capture-workflow.sh
  - templates/form-automation.sh
outputs: [browser_observations, browser_artifacts]
output_contracts:
  browser_observations:
    kind: informative_text
    min_words: 3
    min_length: 18
  browser_artifacts:
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
      - kind: object
        min_keys: 1
        require_any_informative_field: true
consumes: [structured_payload, design_spec]
requires: []
---

# Agent Browser Skill

## Intent

Capture browser-grounded evidence instead of guessing from static assumptions.

## Trigger

Use this skill when:

- the page or workflow must be inspected live
- UI behavior needs evidence from an actual render
- navigation, forms, or auth state matter

## Workflow

### Step 1: Define the navigation target

State the URL, the objective, and the evidence needed.

### Step 2: Run the browser workflow

Navigate, inspect, and capture only the observations relevant to the task.

### Step 3: Emit browser evidence

Produce:

- `browser_observations`: what was seen and what it means
- `browser_artifacts`: screenshots, selectors, or captured evidence references

## Stop Conditions

- the environment cannot access the target page
- auth or sandbox constraints block reliable observation
- the request can be answered confidently from code and docs alone

## Anti-Patterns

- browsing without an evidence target
- treating screenshots as proof without explanation
- replacing repository analysis with page poking

## Example

Input: "Open the docs site, confirm the broken nav state, and capture the failing selector."

Output: `browser_observations`, `browser_artifacts`.
