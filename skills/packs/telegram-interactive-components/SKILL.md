---
name: telegram-interactive-components
description: Generate Telegram interactive UI payloads (inline keyboard and callback flows) with robust fallback text. Use when LLM responses must drive reusable Telegram UI components (buttons, menus, pagination, confirmation screens) and return machine-readable `telegram-ui` blocks for rendering and callback handling.
version: 1.0.0
stability: experimental
tier: pack
tags: [telegram, interactive, ui, inline-keyboard, callback, channel]
anti_tags: [plain-text-only]
tools:
  required: [read]
  optional: [grep]
  denied: []
budget:
  max_tool_calls: 30
  max_tokens: 80000
outputs: [telegram_ui_payload, callback_contract, fallback_text]
consumes: [objective, constraints, inbound_event]
escalation_path:
  unsupported_component: planning
---

# Telegram Interactive Components Skill

## Intent

Produce responses that include both user-facing text and machine-readable UI metadata so a Telegram bridge can render reusable interactive components and process callback events reliably.

## Trigger

- The interaction requires buttons (confirm/cancel, menus, pagination, filters, multi-step flows).
- User actions must round-trip through `callback_query` and re-enter the LLM loop.
- The same response must support both interactive rendering and plain-text fallback.

## Workflow

When interaction is required, output in this exact order:

1. Emit user-facing prose text.
2. Emit exactly one `telegram-ui` JSON code block.
3. If interaction is not required, do not emit a `telegram-ui` block.

### `telegram-ui` Top-Level Schema

```json
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy_confirm_v1",
  "text": "Please choose the next action.",
  "components": [
    {
      "type": "buttons",
      "rows": [
        [
          { "action_id": "confirm", "label": "Confirm", "style": "primary" },
          { "action_id": "cancel", "label": "Cancel", "style": "danger" }
        ]
      ]
    }
  ],
  "state": {
    "flow": "deploy",
    "step": "confirm",
    "target": "service-a"
  },
  "fallback_text": "Reply with: confirm or cancel"
}
```

## Component Model

- `buttons`: Maps directly to `inline_keyboard`.
- `single_select`: Render each option as an individual button.
- `pager`: Render `prev`/`next`/`close` navigation controls.
- `confirm`: Render `confirm`/`cancel` action controls.

Do not emit component types that Telegram cannot render natively. If the product request expects forms, rich cards, or complex layout, downgrade to a button-driven multi-step flow.

## Callback Contract

- `action_id` must match `[a-z0-9_-]`, length 1-24.
- Keep `label` concise (recommended: <= 32 characters).
- Do not embed business payloads in `action_id`.
- Place business context in `state`; let the bridge persist and return a `state_key`.
- Keep encoded `callback_data` within Telegram's 64-byte limit.

Callback events should be injected into subsequent prompts in a structured form like:

```text
[channel:telegram]
turn_kind:user
ui_callback.screen_id: deploy_confirm_v1
ui_callback.action_id: confirm
ui_callback.state_key: st_9f2a
```

After receiving a callback:

1. Interpret the action and update business state.
2. Return the next `telegram-ui` screen, or plain text only when the flow is complete.
3. Always keep `fallback_text` so non-interactive channels remain operable.

## Downgrade Strategy

- If interaction is unavailable, return prose text with explicit reply commands.
- If actions exceed single-screen capacity, split with pagination (`pager`).
- For any rendering failure path, keep executable `fallback_text`.

## Required Outputs

### `telegram_ui_payload`

Provide a `telegram-ui` JSON code block for interactive cases.

### `callback_contract`

Document action semantics and state-transition rules in prose so callback behavior stays auditable.

### `fallback_text`

Provide copy-ready fallback input text (for example, `Reply with: confirm or cancel`).

## Quick Self-Check

- Is there exactly one `telegram-ui` block?
- Does it include `version`, `screen_id`, `components`, and `fallback_text`?
- Are all `action_id` values short, stable, and routable?
- Is business data excluded from callback identifiers?
- Is there a complete fallback path for interaction failure?

## Stop Conditions

- The interaction depends on Telegram-native capabilities that cannot be downgraded to button flows.
- The product scope cannot define a minimal stable action set (`action_id` cannot be made deterministic).
- Upstream bridge infrastructure cannot persist callback state or inject callback events.

## Anti-Patterns

- Emitting multiple `telegram-ui` blocks in one response.
- Packing long business payloads into `action_id` or callback data.
- Returning UI metadata without user-facing prose.
- Omitting `fallback_text`, which breaks non-interactive execution.
- Emitting unsupported complex components without downgrade logic.

## Example

```text
Please confirm deployment for service-a in production.
```

```telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy_confirm_v1",
  "text": "Please confirm deployment for service-a in production.",
  "components": [
    {
      "type": "confirm",
      "rows": [
        [
          { "action_id": "confirm", "label": "Confirm", "style": "primary" },
          { "action_id": "cancel", "label": "Cancel", "style": "danger" }
        ]
      ]
    }
  ],
  "state": {
    "flow": "deploy",
    "target": "service-a",
    "env": "production"
  },
  "fallback_text": "Reply with: confirm or cancel"
}
```
