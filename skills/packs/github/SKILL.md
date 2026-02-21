---
name: github
description: GitHub operations via `gh` CLI for issues, pull requests, checks, workflow runs, and API queries. Use when users need PR/issue lifecycle actions, CI diagnostics, or repository metadata.
version: 1.0.0
stability: stable
tier: pack
tags: [github, gh, pr, issue, ci, review]
anti_tags: [local-git-only]
tools:
  required: [exec, read]
  optional: [grep, ledger_query, skill_complete]
  denied: []
budget:
  max_tool_calls: 90
  max_tokens: 160000
outputs: [github_context, issue_draft, pr_draft, ci_summary]
consumes: [change_summary, verification]
escalation_path:
  gh_not_installed: exploration
  gh_not_authenticated: planning
---

# GitHub Pack Skill

## Intent

Use reproducible `gh` CLI workflows for day-to-day GitHub operations, with a strong emphasis on clear, actionable, and traceable issue/PR artifacts.

## Trigger

Use this skill when the request involves any of the following:

- checking PR status, review state, or merge readiness
- inspecting CI/workflow run results and failure logs
- creating/updating issues with high-quality problem statements
- creating/updating PRs with review-ready change summaries
- querying structured repository data through the GitHub API

## Preconditions

Check CLI availability and authentication first:

```bash
command -v gh
gh auth status
```

If either check fails, report the blocker and stop write operations.

## Mode Detection (mandatory first step)

Classify the task into exactly one mode before executing commands:

| Pattern | Mode | Goal |
| --- | --- | --- |
| create/update issue, triage, bug report | `ISSUE` | produce high-signal issue artifacts |
| create/update/view/merge PR | `PR` | keep reviewable and traceable PR flow |
| checks, runs, workflow failures | `CI` | diagnose and report actionable failures |
| repo stats, labels, custom fields | `API` | return structured data via API |

Blocking output:

```text
GITHUB_CONTEXT
- mode: <ISSUE|PR|CI|API>
- repo: <owner/repo>
- cwd_repo_detected: <yes|no>
- auth_status: <ok|blocked>
- objective: "<user goal>"
```

## Standard Workflow

### Step 1: Resolve repository context

Infer the repository from the current workspace when possible; otherwise require explicit `owner/repo`.

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

### Step 2: Run mode-specific commands

#### ISSUE mode

Common commands:

```bash
gh issue list --repo owner/repo --state open
gh issue view 42 --repo owner/repo
gh issue create --repo owner/repo --title "<title>" --body-file /tmp/issue.md
gh issue comment 42 --repo owner/repo --body "<follow-up>"
```

Issue body template (`/tmp/issue.md`):

```markdown
## Problem

<what is broken and who is affected>

## Current Behavior

<actual behavior with concrete symptoms>

## Expected Behavior

<expected outcome>

## Reproduction

1. <step>
2. <step>
3. <step>

## Scope / Impact

- Affected modules: <module list>
- Severity: <low|medium|high>
- Frequency: <always|intermittent>

## Acceptance Criteria

- [ ] <checkable condition>
- [ ] <checkable condition>
```

#### PR mode

Common commands:

```bash
gh pr list --repo owner/repo
gh pr view 55 --repo owner/repo
gh pr checks 55 --repo owner/repo
gh pr create --repo owner/repo --title "<title>" --body-file /tmp/pr.md
gh pr merge 55 --repo owner/repo --squash
```

PR body template (`/tmp/pr.md`):

```markdown
## Summary

<one-paragraph change summary>

## Changes

- <change item>
- <change item>

## Verification

- <test command/result>
- <test command/result>

## Risk

- <known risk or "none">

## Related Issue

Fixes #<issue_number>
```

#### CI mode

```bash
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo
gh run view <run-id> --repo owner/repo --log-failed
gh run rerun <run-id> --failed --repo owner/repo
```

#### API mode

```bash
gh api repos/owner/repo --jq '{defaultBranch: .default_branch, stars: .stargazers_count}'
gh api repos/owner/repo/pulls/55 --jq '{title: .title, state: .state, author: .user.login}'
gh api repos/owner/repo/labels --jq '.[].name'
```

### Step 3: Emit structured output

```text
ISSUE_DRAFT
- title: "<issue title>"
- key_problem: "<one-line problem statement>"
- impact: "<who/what is affected>"
- acceptance_criteria:
  - "<criterion>"

PR_DRAFT
- title: "<pr title>"
- summary: "<what changed>"
- verification:
  - "<check>"

CI_SUMMARY
- run_id: "<id>"
- status: "<success|failed|in_progress>"
- actionable_failures:
  - "<failure>"
```

## Stop Conditions

- `gh` is unavailable and cannot be installed in the current environment.
- `gh auth status` fails and no valid credentials are available.
- Repository permissions are insufficient for issue/PR write actions.
- The task requires complex browser-driven flows that are not reliable in CLI-only execution.

## Anti-Patterns (never)

- Creating issues/PRs without confirming repository context.
- Writing issues with vague, non-actionable descriptions such as "something is broken."
- Opening PRs without verification evidence or issue linkage.
- Using `gh` for local Git fundamentals (`commit`, `rebase`, `cherry-pick`).

## Example

Input:

```text
"Create an issue in owner/repo describing that API retry logic fails on HTTP 429, including reproducible steps."
```

Expected sequence:

1. Emit `GITHUB_CONTEXT` (`mode=ISSUE`).
2. Draft a structured issue body (Problem/Current/Expected/Reproduction/Impact/Acceptance).
3. Create the issue via `gh issue create` and return the issue URL/number.
