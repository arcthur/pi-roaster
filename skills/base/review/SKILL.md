---
name: review
description: Risk-driven code review for merge safety with evidence-based findings.
version: 1.1.0
stability: stable
tier: base
tags: [review, quality, bug, risk, merge-safety]
anti_tags: [implementation]
tools:
  required: [read, grep]
  optional: [lsp_diagnostics, ledger_query, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 60
  max_tokens: 120000
outputs: [review_context, risk_profile, findings, review_decision, testing_gaps]
consumes: [change_summary, files_changed, verification, execution_steps]
escalation_path:
  scope_unknown: exploration
  cross_skill_orchestration: compose
---

# Review Skill

## Intent

Assess change risk with the minimum sufficient evidence and produce an actionable merge decision.

## Trigger

Use this skill for:

- code review requests
- pre-merge risk checks
- regression or quality audits

## Core Principles

- findings first; conclusions must be evidence-backed
- model risk before selecting review depth
- prioritize root-cause issues over style suggestions
- review is read-only; do not implement changes, run verification commands, or perform Git operations
- follow executable-evidence policy from `skills/base/planning/references/executable-evidence-bridge.md`

## Review Workflow

### Step 1: Scope and intent (mandatory)

Collect and state explicitly:

- change scope (`files/modules/commit range`)
- change intent (`what changed and why`)
- critical paths (`auth/payment/data-write/runtime entry`)
- existing verification signals (`tests/diagnostics/monitoring evidence`)

If no diff is available, explicitly declare the review target and key assumptions.

Blocking output:

```text
REVIEW_CONTEXT
- scope: <files/modules/commit-range>
- intent: "<what changed and why>"
- critical_paths:
  - "<path>"
- assumptions:
  - "<assumption>"
```

### Step 2: Risk modeling and depth routing (mandatory)

Score each factor as `0|1|2` and compute the total:

1. `Change Surface`
2. `Critical Path`
3. `Data/State Mutation`
4. `External Exposure`
5. `Concurrency/Ordering` (including TOCTOU)
6. `Contract Drift` (API/Schema/Event compatibility)

Depth routing rules:

- `0-3` => `QUICK`
- `4-7` => `DEEP`
- `>=8` => `DEEP` + mandatory `security` lane
- any `P0/P1` finding or insufficient critical-path evidence => upgrade from `QUICK` to `DEEP`

Blocking output:

```text
RISK_PROFILE
- mode: <QUICK|DEEP>
- score: <0-12>
- factors:
  - name: "<factor>"
    score: <0|1|2>
    reason: "<why>"
- activated_lanes:
  - "<core|security|architecture|performance|ux>"
```

### Step 3: Evidence collection by lane

`core` lane (always enabled):

- correctness and edge cases
- regression risk and compatibility
- maintainability and clarity

In `DEEP`, activate additional lanes based on risk:

- `security` lane: `skills/base/review/references/security-concurrency.md`
- `architecture` lane: `skills/base/review/references/contract-drift.md`
- `performance` lane: `skills/base/review/references/boundary-failure.md`
- `ux` lane: enable only when UI changes are explicit, focusing on state flows and accessibility risks

### Step 4: Emit findings first

Output order is mandatory:

1. findings (highest severity first)
2. open questions / assumptions
3. testing gaps
4. decision summary

Severity labels:

- `P0`: release-blocking, data loss, security-critical
- `P1`: high-impact bug or likely regression
- `P2`: reliability/maintainability issue
- `P3`: low-impact improvement

Every finding must include:

- severity
- confidence (`high|medium|low`)
- location (`path:symbol`)
- issue (root cause)
- impact (user/system/business impact)
- evidence (code path, contract delta, test signal, or log signal)
- recommendation (minimal safe fix direction)

Blocking template:

```text
FINDING
- severity: <P0|P1|P2|P3>
- confidence: <high|medium|low>
- location: <path:symbol>
- issue: "<root problem>"
- impact: "<user/system/business impact>"
- evidence: "<code path/test/log/contract diff>"
- recommendation: "<minimal safe fix>"
```

### Step 5: Decision and handoff

Decision types:

- `APPROVE`: no actionable issues and critical evidence is complete
- `APPROVE_WITH_RISKS`: only acceptable residual risks remain
- `REQUEST_CHANGES`: required fixes are present (typically includes `P1`)
- `BLOCK`: `P0` exists or critical evidence is missing for safe merge

Decision template:

```text
REVIEW_DECISION
- verdict: <APPROVE|APPROVE_WITH_RISKS|REQUEST_CHANGES|BLOCK>
- required_actions:
  - "<must-fix item>"
- testing_gaps:
  - "<missing evidence>"
- residual_risks:
  - "<accepted risk>"
```

### Step 6: Evidence bridge on blocker

If risk is high and required verification evidence cannot be obtained, emit `TOOL_BRIDGE` using:
`skills/base/planning/references/executable-evidence-bridge.md`

Handoff boundary:

- implementation work => `patching`
- verification execution => `verification`
- commit/history operations => `git`
- cross-skill orchestration => `compose`

## Stop Conditions

- review scope or change intent cannot be identified
- required files or contract definitions are missing, preventing reliable evidence collection
- risk is high while evidence is insufficient for a defensible severity call and no meaningful `TOOL_BRIDGE` can be produced

When blocked, state exactly which artifact is missing.

## Anti-Patterns (never)

- skipping risk modeling and jumping directly to conclusions
- prioritizing style comments over behavior/risk issues
- modifying code during the review phase
- presenting strong conclusions without confidence labels
- claiming "no issues" without disclosing residual risks or testing gaps

## Example

Input:

```text
"Review runtime gate changes for merge safety."
```

Expected outputs:

1. `REVIEW_CONTEXT`
2. `RISK_PROFILE` with `QUICK` or `DEEP`
3. Findings list (`P0-P3`, with confidence and evidence)
4. `REVIEW_DECISION` + `testing_gaps`
