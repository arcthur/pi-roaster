---
name: telegram
description: Design Telegram channel behavior and interactive payloads as one channel-native
  response workflow.
stability: stable
intent:
  outputs:
    - telegram_response_plan
    - telegram_payload
  output_contracts:
    telegram_response_plan:
      kind: text
      min_words: 3
      min_length: 18
    telegram_payload:
      kind: json
      min_keys: 1
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 60
    max_tokens: 120000
  hard_ceiling:
    max_tool_calls: 90
    max_tokens: 180000
execution_hints:
  preferred_tools:
    - read
  fallback_tools:
    - grep
    - look_at
    - skill_complete
consumes:
  - structured_payload
  - review_report
requires: []
---

# Telegram Skill

## Intent

Choose the right Telegram interaction strategy and the matching payload in one pass.

## Trigger

Use this skill when:

- the output will be delivered in Telegram
- channel behavior and interactive components must stay aligned
- message density, interaction design, or CTA structure matters

## Workflow

### Step 1: Pick response strategy

Determine whether the message should be push-only, choice-driven, or workflow-guided.

### Step 2: Shape the payload

Design text structure, buttons, and interaction constraints together.

### Step 3: Emit channel artifacts

Produce:

- `telegram_response_plan`: tone, density, CTA strategy
- `telegram_payload`: channel-ready structure for the chosen interaction

## Stop Conditions

- the target channel is not Telegram
- upstream content is too ambiguous to shape into a safe interaction
- the task is really about general UX, not Telegram delivery

## Anti-Patterns

- separating channel strategy from payload generation
- mirroring desktop UX patterns without Telegram constraints
- overloading one message with too many decisions

## Example

Input: "Design a Telegram admin prompt with concise copy and two-step confirmation buttons."

Output: `telegram_response_plan`, `telegram_payload`.
