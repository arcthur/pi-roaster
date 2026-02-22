---
name: review
description: Risk-driven merge-safety review with deterministic issue tables and evidence-backed decisions.
version: 2.0.0
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

Assess merge risk with the minimum sufficient evidence and produce:

- deterministic, fix-ready issue inventory
- explicit merge decision
- clear testing gaps and residual risks

## Trigger

Use this skill for:

- code review requests
- pre-merge risk checks
- regression or quality audits

## Core Principles

- findings first; conclusions must be evidence-backed
- risk model before depth selection
- prioritize behavior, safety, compatibility, and operability over style
- all issues must be traceable with stable IDs and locations
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

Required output:

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

Required output:

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

### Step 3: Check plan and evidence collection

Before reviewing details, enumerate checks and concrete search targets.

`CHECKS_PERFORMED` must be included in the final report.

Each check entry must include:

- `name` (stable check label)
- `lane` (`core|security|architecture|performance|ux`)
- `patterns` (what was inspected, APIs/paths/symbols/contracts)
- `result` (`no_issue|issue_found|insufficient_evidence`)

If an external aggregated review tool (for example `code_review`) is available, treat it as a supplemental check only:

- use it to broaden candidate issue discovery
- still perform lane-based validation for severity, confidence, and evidence
- never skip Step 1/Step 2 risk modeling because of tool output

`core` lane (always enabled):

- correctness and edge cases
- regression risk and compatibility
- maintainability and clarity

In `DEEP`, activate additional lanes based on risk:

- `security` lane: `skills/base/review/references/security-concurrency.md`
- `architecture` lane: `skills/base/review/references/contract-drift.md`
- `performance` lane: `skills/base/review/references/boundary-failure.md`
- `ux` lane: enable only when UI changes are explicit, focusing on state flows and accessibility risks

### Step 4: Emit findings first (mandatory ordering)

Output order is mandatory:

1. findings (highest severity first)
2. normalized results table
3. open questions / assumptions
4. testing gaps
5. decision summary

Severity labels:

- `P0`: release-blocking, data loss, security-critical
- `P1`: high-impact bug or likely regression
- `P2`: reliability/maintainability issue
- `P3`: low-impact improvement

External severity mapping (for table output):

- `P0` => `CRITICAL`
- `P1` => `HIGH`
- `P2` => `MEDIUM`
- `P3` => `LOW`

Every finding must include:

- severity
- confidence (`high|medium|low`)
- location (`path:symbol`)
- issue (root cause)
- impact (user/system/business impact)
- evidence (code path, contract delta, test signal, or log signal)
- recommendation (minimal safe fix direction)

Required finding template:

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

Findings must be numbered sequentially starting from `1` in report order.

If no findings exist, emit:

```text
NO_FINDINGS
- rationale: "<why no actionable issue was found>"
- residual_risks:
  - "<remaining uncertainty>"
```

### Step 5: Emit normalized results table (mandatory)

After `FINDING` blocks, emit this exact header and columns:

```text
Code Review Results
X issues found across Y checks

#	Severity	Source	Location	Problem	Why	Fix
1	CRITICAL	security	path:line	problem text	why text	fix text
2	HIGH	core	path:line	problem text	why text	fix text
3	MEDIUM	architecture	path:line	problem text	why text	fix text
4	LOW	performance	path:line	problem text	why text	fix text
```

Rules:

- `#` must match finding IDs.
- `Severity` must use mapped external severity (`CRITICAL/HIGH/MEDIUM/LOW`).
- `Source` should be the originating lane (`core/security/architecture/performance/ux`).
- `Location` should be `file:line` when available; otherwise `path:symbol`.
- `Problem/Why/Fix` must be concise and actionable.
- `X` is actionable issue count, `Y` is checks count from `CHECKS_PERFORMED`.

Then emit:

```text
Checks performed:
- <check_name>: <patterns inspected> => <result>
- <check_name>: <patterns inspected> => <result>
```

### Step 6: Decision and handoff

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

Final interaction line:

- if `X > 0`, ask exactly:
  `"Would you like me to fix any of these issues? (e.g., 'fix issue #1' or 'fix issues #2 and #3')"`
- if `X = 0`, state that no actionable issues were found and list residual risks/testing gaps.

### Step 7: Evidence bridge on blocker

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
- presenting checklists without issue-to-evidence mapping
- emitting table rows that cannot be traced back to findings
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
3. `CHECKS_PERFORMED`
4. Findings list (`P0-P3`, with confidence and evidence)
5. `Code Review Results` table + checks list
6. `REVIEW_DECISION` + `testing_gaps`
