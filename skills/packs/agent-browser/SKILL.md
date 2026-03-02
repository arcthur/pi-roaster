---
name: agent-browser
description: Browser automation workflow for navigation, interaction, extraction, and visual verification.
version: 1.0.0
stability: stable
tier: pack
tags: [agent-browser, browser, automation, e2e, screenshot, extraction]
anti_tags: [backend-only]
tools:
  required: [exec, read]
  optional: [look_at, ledger_query, skill_complete]
  denied: []
budget:
  max_tool_calls: 70
  max_tokens: 140000
outputs: [browser_plan, action_log, extraction_result, troubleshooting]
consumes: [execution_steps]
escalation_path:
  browser_env_missing: exploration
---

# Agent Browser Pack Skill

## Intent

Automate browser tasks with reproducible steps for navigation, form interaction, extraction, and visual evidence.

## Trigger

Use this pack when user asks to:

- navigate websites and interact with elements
- fill forms and verify outcomes
- capture screenshots/PDFs/video
- extract page data with evidence

## Preconditions

Check CLI availability before planning:

```bash
agent-browser --help
```

If unavailable, report installation requirement and stop browser actions.

## Standard Workflow

### Step 1: Define task contract

Capture target:

- URL(s)
- expected interaction flow
- success criteria
- output artifact requirement (text/screenshot/pdf/video)

Blocking output:

```text
BROWSER_PLAN
- target_url: "<url>"
- objective: "<task goal>"
- success_criteria:
  - "<criterion>"
- expected_artifacts:
  - "<artifact>"
```

### Step 2: Navigate and snapshot

```bash
agent-browser open <url>
agent-browser snapshot -i
```

Rule:

- Always take `snapshot -i` before first interaction.
- Re-snapshot after navigation or major DOM update.

### Step 3: Interact through stable refs

Use refs from snapshot output (`@e1`, `@e2`, ...):

```bash
agent-browser click @e1
agent-browser fill @e2 "value"
agent-browser select @e3 "option"
agent-browser press Enter
```

Prefer ref-based commands over brittle CSS selectors.

Fallback:

- If refs are unavailable or unstable, use semantic locators from `Semantic Locator Fallback`.

### Step 4: Wait for deterministic state

```bash
agent-browser wait --load networkidle
agent-browser wait --text "Success"
agent-browser wait --url "**/dashboard"
```

Rule:

- Avoid fixed sleeps unless no deterministic wait condition exists.
- For untrusted pages or high-impact actions, apply `Security Baseline` first.

### Step 5: Capture evidence artifacts

```bash
agent-browser screenshot output.png
agent-browser screenshot --full fullpage.png
agent-browser pdf output.pdf
```

For video:

```bash
agent-browser record start run.webm
# perform interactions
agent-browser record stop
```

Optional verification before final capture:

```bash
agent-browser snapshot -i
agent-browser click @e2
agent-browser diff snapshot
```

Use `Diff Verification` for state-changing flows to prove effect, then capture final artifacts.

### Step 6: Emit structured result

```text
ACTION_LOG
- step: "<action>"
  result: "<success/fail>"
  evidence: "<snapshot/screenshot/info>"

EXTRACTION_RESULT
- key: "<data key>"
  value: "<value>"
```

## Command Reference

### Navigation

```bash
agent-browser open <url>
agent-browser back
agent-browser forward
agent-browser reload
agent-browser close
```

### Snapshot and state

```bash
agent-browser snapshot
agent-browser snapshot -i
agent-browser get title
agent-browser get url
agent-browser is visible @e1
```

### Interaction

```bash
agent-browser click @e1
agent-browser dblclick @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser hover @e1
agent-browser check @e1
agent-browser uncheck @e1
agent-browser upload @e1 <file>
```

### Data extraction

```bash
agent-browser get text @e1
agent-browser get value @e2
agent-browser get attr @e1 href
agent-browser get count ".item"
```

### Network and auth helpers

```bash
agent-browser set headers '{"Authorization":"Bearer <token>"}'
agent-browser network requests
agent-browser cookies
agent-browser state save auth.json
agent-browser state load auth.json
```

## Session and profile strategy

- Use `--session <name>` for isolated parallel flows.
- Use `--profile <path>` for persistent login state.
- For multi-step authentication, save state once and reuse.

## Security Baseline (optional, recommended)

Deep-dive reference: `skills/packs/agent-browser/references/security-baseline.md`

All controls are opt-in. For agent workflows on untrusted pages, enable at least:

- `content boundaries` to reduce prompt-injection confusion
- domain allowlist to block off-target navigation
- action policy to deny destructive operations by default
- output limits to avoid context flooding

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"
export AGENT_BROWSER_ACTION_POLICY=./policy.json
export AGENT_BROWSER_MAX_OUTPUT=50000
```

Example policy:

```json
{
  "default": "deny",
  "allow": ["navigate", "snapshot", "click", "scroll", "wait", "get"]
}
```

Notes:

- Include required CDN/asset domains in `AGENT_BROWSER_ALLOWED_DOMAINS`.
- Auth vault commands can bypass action policy; allowlist still applies.

## Diff Verification (optional, recommended for state changes)

Deep-dive reference: `skills/packs/agent-browser/references/diff-verification.md`

Use `diff` to verify that an interaction changed the page as intended.

```bash
# baseline
agent-browser snapshot -i
# action
agent-browser click @e2
# verification
agent-browser diff snapshot
```

Visual regression flow:

```bash
agent-browser screenshot baseline.png
# later or after changes
agent-browser diff screenshot --baseline baseline.png
```

Cross-environment comparison:

```bash
agent-browser diff url https://staging.example.com https://prod.example.com --screenshot
```

## Semantic Locator Fallback

Deep-dive reference: `skills/packs/agent-browser/references/semantic-locators.md`

When refs are not available, stale, or repeatedly unstable, switch to semantic locators:

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

Rules:

- Prefer refs first (`snapshot -i`), semantic locators second.
- After navigation or major DOM change, re-snapshot and return to refs when possible.

## Eval Safe Mode

Deep-dive reference: `skills/packs/agent-browser/references/eval-safe-mode.md`

Use `eval` for browser-context JavaScript only when built-in commands cannot express the check/extraction.

```bash
# simple expressions
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'
```

For complex JS, avoid shell quoting hazards by using `--stdin` or `-b`:

```bash
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("a")).map(a => a.href)
)
EVALEOF
```

```bash
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll(\"a\")).map(a => a.href)' | base64)"
```

Rules of thumb:

- Single-line and quote-simple: regular `eval '...'`.
- Nested quotes, template literals, multiline, or generated scripts: prefer `--stdin`.

## References

- Security baseline details: `skills/packs/agent-browser/references/security-baseline.md`
- Diff verification patterns: `skills/packs/agent-browser/references/diff-verification.md`
- Semantic locator fallback patterns: `skills/packs/agent-browser/references/semantic-locators.md`
- Eval safe mode patterns: `skills/packs/agent-browser/references/eval-safe-mode.md`

## Ready-to-Use Templates

- Form automation with diff evidence: `skills/packs/agent-browser/templates/form-automation.sh`
- Authenticated session reuse with state file: `skills/packs/agent-browser/templates/authenticated-session.sh`
- Capture workflow with optional verification click: `skills/packs/agent-browser/templates/capture-workflow.sh`

```bash
./skills/packs/agent-browser/templates/form-automation.sh <form-url> @e1 "value1" @e2 "value2" @e3 "**/success"
./skills/packs/agent-browser/templates/authenticated-session.sh <login-url> <target-url> ./auth-state.json
./skills/packs/agent-browser/templates/capture-workflow.sh <url> ./browser-artifacts @e5
```

## Troubleshooting

| Symptom                   | Likely Cause                  | Action                             |
| ------------------------- | ----------------------------- | ---------------------------------- |
| Ref no longer valid       | DOM changed after interaction | Run `snapshot -i` again            |
| Click has no effect       | Element not visible/enabled   | Check `is visible`, scroll or wait |
| Form submit hangs         | Network still pending         | `wait --load networkidle`          |
| Auth redirects to login   | Session not persisted         | `state load` or set headers        |
| Screenshot missing target | Wrong viewport/scroll         | set viewport and `scrollintoview`  |

Blocking troubleshooting report:

```text
TROUBLESHOOTING
- symptom: "<observed issue>"
- attempted_actions:
  - "<action>"
- next_action: "<specific command>"
```

## Stop Conditions

- Browser CLI/tooling unavailable.
- Target site blocks automation with hard anti-bot constraints.
- Required credentials are missing.
- Workflow exceeds tool budget without stable progress.
- Automation is blocked and no meaningful `TOOL_BRIDGE` can be produced.

If browser automation cannot execute, emit `TOOL_BRIDGE` using
`skills/base/planning/references/executable-evidence-bridge.md` for a reproducible human-run flow.

## Anti-Patterns (never)

- Interacting without initial snapshot.
- Reusing stale refs after page transition.
- Using hardcoded sleeps as primary sync strategy.
- Reporting extraction results without evidence artifact.

## Example

Input:

```text
"Login to dashboard, capture billing summary, and save screenshot."
```

Expected sequence:

1. `BROWSER_PLAN` with objective and artifacts.
2. open -> snapshot -> fill -> click -> wait.
3. extract billing values with `get text`.
4. capture screenshot and emit `ACTION_LOG` + `EXTRACTION_RESULT`.
