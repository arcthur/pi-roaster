---
name: github
description: Operate on GitHub issues, PRs, CI, and repository metadata through one
  coherent `gh`-driven workflow.
stability: stable
intent:
  outputs:
    - github_context
    - issue_brief
    - pr_brief
    - ci_findings
  output_contracts:
    github_context:
      kind: text
      min_words: 3
      min_length: 18
    issue_brief:
      kind: text
      min_words: 3
      min_length: 18
    pr_brief:
      kind: text
      min_words: 3
      min_length: 18
    ci_findings:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 160000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 220000
execution_hints:
  preferred_tools:
    - exec
    - read
  fallback_tools:
    - grep
    - ledger_query
    - skill_complete
consumes:
  - change_set
  - verification_evidence
  - review_report
requires: []
---

# GitHub Skill

## Intent

Handle issue, PR, and CI work as one domain so repository operations stay coherent and auditable.

## Trigger

Use this skill when:

- the request targets issues, PRs, checks, or workflow runs
- a repo action should happen through `gh`
- CI evidence or GitHub metadata is required

## Workflow

### Step 1: Resolve repo context

Verify `gh` availability, auth, and target repository.

### Step 2: Select workflow mode

Choose `issue`, `pull_request`, `ci`, or `api_query`.

### Step 3: Emit domain artifacts

Produce:

- `github_context`: repo, auth, and target object
- `issue_brief` or `pr_brief`: actionable artifact draft
- `ci_findings`: failed checks and next actions when CI is involved

## Stop Conditions

- `gh` is unavailable or unauthenticated
- repository permissions block the requested write action
- the task needs browser-driven interaction rather than CLI workflows

## Anti-Patterns

- splitting issue triage and PR flow into separate public skills
- acting on the wrong repository context
- creating vague issues or PRs with no acceptance or verification signal

## Example

Input: "Use gh to summarize the failing checks on this PR and draft a follow-up comment."

Output: `github_context`, `ci_findings`, `pr_brief`.
