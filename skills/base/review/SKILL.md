---
name: review
description: Review code for correctness, regressions, security, and maintainability.
version: 1.0.0
stability: stable
tier: base
tags: [review, quality, bug, risk]
anti_tags: [implementation]
tools:
  required: [read, grep]
  optional: [lsp_diagnostics, ledger_query, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 55
  max_tokens: 120000
outputs: [findings, severity, recommendations, testing_gaps]
consumes: [change_summary, files_changed, verification, execution_steps]
escalation_path:
  scope_unknown: exploration
---

# Review Skill

## Intent
Provide prioritized findings on correctness, safety, and maintainability with evidence.

## Trigger
Use this skill for:
- code review requests
- pre-merge risk checks
- regression or quality audits

## Review Workflow

### Step 1: Build review context
Collect:
- changed files and intent
- related tests and verification signals
- impacted interfaces/contracts

If no diff is available, review requested target files with explicit assumptions.

### Step 2: Inspect by dimension
Evaluate every target across these dimensions:
1. Correctness and edge cases
2. Regression risk and compatibility
3. Security and data handling
4. Performance/resource implications
5. Maintainability and clarity

### Step 3: Severity classification
Use consistent severity labels:
- `P0`: release-blocking, data loss, security-critical
- `P1`: high-impact functional bug or likely regression
- `P2`: medium issue affecting reliability or maintainability
- `P3`: low-impact improvement opportunity

Each finding must include:
- why it is a problem
- where it appears (file/symbol)
- expected impact
- concrete fix direction

### Step 4: Emit findings first
Output order:
1. findings (highest severity first)
2. open questions/assumptions
3. short summary

Template:
```text
FINDING
- severity: <P0|P1|P2|P3>
- location: <path:symbol>
- issue: "<what is wrong>"
- impact: "<user/system impact>"
- recommendation: "<specific fix>"
```

### Step 5: Report testing gaps
List missing or weak verification coverage:
- absent unit tests for new branches
- missing integration checks for shared boundaries
- no validation for failure/recovery paths

## Review Heuristics
- Favor root-cause findings over style nits.
- Prioritize behavior-changing issues over formatting.
- Treat mutable shared state and concurrency as high-risk.
- Treat contract/schema drift as high-risk even if tests pass locally.

## Stop Conditions
- Cannot identify intent or scope of reviewed changes.
- Required files are missing from repository snapshot.
- Evidence is insufficient to make reliable severity call.

When blocked, state exactly which artifact is missing.

## Anti-Patterns (never)
- Giving only generic praise without findings.
- Reporting style-only comments as top findings.
- Claiming "no issues" without discussing residual risk.
- Mixing uncertain speculation with confirmed bugs.

## Example

Input:
```text
"Review verification gate changes for regressions and missing tests."
```

Expected output:
1. Findings list with `P0-P3` severity.
2. Assumptions and open questions.
3. `testing_gaps` section for missing coverage.
