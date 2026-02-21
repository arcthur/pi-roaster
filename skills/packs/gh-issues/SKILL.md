---
name: gh-issues
description: GitHub issue triage and issue-to-PR execution workflow via `gh` CLI. Use when processing filtered issues, writing actionable issue specs, converting selected issues into PRs, and tracking review follow-ups.
version: 1.0.0
stability: stable
tier: pack
tags: [github, gh, issues, triage, pr, review]
anti_tags: [single-command-only]
tools:
  required: [exec, read]
  optional: [grep, ledger_query, skill_complete]
  denied: []
budget:
  max_tool_calls: 120
  max_tokens: 180000
outputs: [issue_triage, issue_spec, issue_execution_plan, review_followup]
consumes: [github_context, verification]
escalation_path:
  scope_unclear: planning
  repo_access_blocked: exploration
---

# gh-issues Pack Skill

## Intent

Standardize issue handling into a deterministic lifecycle: filter -> triage -> implement -> PR -> review follow-up. The goal is to prevent vague or non-executable issue/PR communication.

## Trigger

Use this skill when the request includes any of these goals:

- list or filter issues in batches (label, assignee, milestone, state)
- upgrade issue descriptions to be reproducible and acceptance-testable
- convert selected issues into concrete changes with linked PRs
- process PR review comments and respond with explicit resolution status

## Preconditions

Validate local prerequisites:

```bash
command -v gh
gh auth status
git rev-parse --is-inside-work-tree
```

If authentication, repository context, or write permissions are missing, report the blocker and stop before write operations.

## Workflow

### Step 1: Define filter contract

Define processing scope explicitly:

- source repository (`owner/repo`)
- issue state (`open|closed|all`)
- `label` / `assignee` / `milestone` filters
- result limit (recommended: 5-20)

Blocking output:

```text
ISSUE_TRIAGE_SCOPE
- repo: <owner/repo>
- state: <open|closed|all>
- label: <value|none>
- assignee: <value|none>
- milestone: <value|none>
- limit: <n>
```

### Step 2: Fetch and triage issues

```bash
gh issue list \
  --repo owner/repo \
  --state open \
  --limit 20 \
  --json number,title,labels,assignees,url,updatedAt
```

Produce triage output with at least:

- priority (`P0|P1|P2`)
- actionability (`actionable|needs-clarification`)
- recommended action (`fix-now|clarify-first|defer`)

Blocking output:

```text
ISSUE_TRIAGE
- issue: "#42"
  priority: "P1"
  actionability: "actionable"
  recommended_action: "fix-now"
```

### Step 3: Build clear issue spec

For each selected issue, produce a normalized spec that can be used directly in `gh issue edit --body-file` or in clarification comments:

```markdown
## Problem

<single-sentence problem statement>

## Why It Matters

<impact to users/systems>

## Reproduction

1. <step>
2. <step>
3. <step>

## Expected vs Actual

- Expected: <expected>
- Actual: <actual>

## Acceptance Criteria

- [ ] <criterion>
- [ ] <criterion>
```

### Step 4: Pre-flight before implementation

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
gh pr list --repo owner/repo --search "head:fix/issue-42 state:open"
```

Rules:

- If the working tree is dirty and could contaminate commits, stop and resolve it explicitly.
- If an open PR already exists for `fix/issue-{N}`, skip that issue by default.

### Step 5: Execute issue-to-PR flow

```bash
git checkout -b fix/issue-42
# implement fix
# run relevant tests
git add <files>
git commit -m "fix: <short summary>

Fixes owner/repo#42"
git push -u origin fix/issue-42
gh pr create --repo owner/repo --title "fix: <title>" --body-file /tmp/pr-42.md
```

Minimum PR body requirements:

- Summary: what changed and why
- Changes: key implementation deltas
- Verification: executed checks/tests
- Risk: known risk or explicit "none"
- Issue linkage: `Fixes #42`

### Step 6: Handle review follow-up

```bash
gh pr checks <pr-number> --repo owner/repo
gh pr view <pr-number> --repo owner/repo --comments
```

For each review comment, report a clear resolution status:

- `Addressed`: implemented, with commit/file reference
- `Deferred`: postponed, with rationale and condition
- `Rejected`: not adopted, with technical justification

Blocking output:

```text
REVIEW_FOLLOWUP
- pr: "#99"
- addressed:
  - "<comment summary -> commit/file>"
- deferred:
  - "<reason>"
- rejected:
  - "<reason>"
```

## Stop Conditions

- The issue cannot be reduced to a minimal executable scope (and cannot be clarified sufficiently).
- Local or remote permissions are insufficient to push branches or create PRs.
- Required validation cannot be executed and no acceptable alternative evidence exists.
- The requested fix expands into large cross-subsystem refactoring beyond issue scope.

## Anti-Patterns (never)

- Processing all issues blindly without triage.
- Shipping issue/PR descriptions without reproduction steps or acceptance criteria.
- Opening duplicate PRs when an equivalent open PR already exists.
- Introducing unrelated refactors or new dependencies just to "finish" an issue.

## Example

Input:

```text
"Process the first five `label=bug` issues in owner/repo, prioritize directly actionable ones, and open a PR for each completed fix."
```

Expected sequence:

1. Emit `ISSUE_TRIAGE_SCOPE` and `ISSUE_TRIAGE`.
2. Select issue subset by actionability + priority.
3. For each issue: pre-flight -> branch -> fix -> test -> PR.
4. Return PR links and `REVIEW_FOLLOWUP` status per issue.
