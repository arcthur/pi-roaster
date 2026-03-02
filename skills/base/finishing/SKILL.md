---
name: finishing
description: Use when implementation is complete, all tasks pass, and you need to decide how to integrate the work.
version: 1.0.0
stability: stable
tier: base
tags: [finish, merge, pr, integrate, branch]
anti_tags: [explore, debug]
tools:
  required: [exec, read]
  optional: [grep, skill_complete]
  denied: []
budget:
  max_tool_calls: 40
  max_tokens: 80000
outputs: [finish_readiness, finish_decision, finish_report]
consumes: [execution_report, verification, change_summary]
escalation_path:
  tests_failing: debugging
  merge_conflicts: git
---

# Finishing Skill

## Intent

Guide completion of development work by verifying tests, presenting structured integration options, and executing the chosen workflow cleanly.

## Trigger

Use this skill when implementation is complete, all tasks pass, and you need to decide how to integrate the work.

## Iron Law

**NO COMPLETION CLAIMS WITHOUT FRESH TEST EVIDENCE.**

## Workflow (mandatory order)

### Step 1: Verify tests

Run the full project test suite. Capture command and output.

```bash
bun run check
bun test
```

**STOP if any test fails.** Escalate to `debugging` skill.

### Step 2: Determine base branch and gather state

```bash
git branch --show-current
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"
git log --oneline main..HEAD 2>/dev/null || git log --oneline master..HEAD
git diff --stat main..HEAD 2>/dev/null || git diff --stat master..HEAD
```

Blocking output:

```text
FINISH_READINESS
- branch: "<branch-name>"
- base_branch: "<base>"
- test_status: <pass|fail>
- test_evidence: "<command + result summary>"
- commits_ahead: <N>
- files_changed: <N>
```

Do not continue if `test_status` is `fail`.

### Step 3: Present options

Present exactly four options. Do not add others.

| Option | Label   | Description                              |
| ------ | ------- | ---------------------------------------- |
| 1      | MERGE   | Merge branch into base locally and push  |
| 2      | PR      | Push branch and create a pull request    |
| 3      | KEEP    | Leave branch as-is for later integration |
| 4      | DISCARD | Delete branch and discard all work       |

**Option 4 (DISCARD) safety gate:** Before executing, list every commit that will be lost and require the user to type the branch name to confirm.

Wait for user selection before proceeding.

Blocking output after selection:

```text
FINISH_DECISION
- option: <MERGE|PR|KEEP|DISCARD>
- rationale: "<why>"
```

### Step 4: Execute chosen option

**MERGE:**

```bash
git checkout <base_branch>
git merge <branch> --no-ff
git push origin <base_branch>
git branch -d <branch>
```

**PR:**

```bash
git push -u origin <branch>
# Provide PR creation command or URL
```

**KEEP:** No action. Confirm branch is preserved.

**DISCARD:**

```bash
git checkout <base_branch>
git branch -D <branch>
```

### Step 5: Cleanup and report

Remove worktree only for MERGE and DISCARD options. For PR and KEEP, preserve worktree.

Blocking output:

```text
FINISH_REPORT
- action_taken: "<what was done>"
- branch_status: <merged|pushed|kept|discarded>
- cleanup: <worktree_removed|worktree_kept|not_applicable>
- verification: "<post-action check>"
- residual_notes: "<anything to track>"
```

## Stop Conditions

- Tests fail after rerun.
- Base branch cannot be determined.
- Merge produces unresolvable conflicts (escalate to `git` skill).
- User declines all four options.

When stopped, output what was tried and what exact input is needed next.

## Anti-Patterns (never)

- Skipping test verification before presenting options.
- Open-ended "what do you want to do next?" instead of the four structured options.
- Auto-removing worktree for PR or KEEP options.
- Executing DISCARD without explicit typed confirmation.
- Claiming merge success without post-merge verification.
- Force-pushing without explicit warning.

## Red Flags

- Proceeding with failing tests.
- Merging without verification evidence.
- Force-pushing without warning.
- Deleting work without confirmation.
