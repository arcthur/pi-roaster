---
name: git
description: Use when creating commits, rebasing branches, or searching git history — covers commit architecture, rebase surgery, and blame/bisect workflows.
version: 1.0.0
stability: stable
tier: base
tags: [git, branch, commit, rebase, blame, bisect]
anti_tags: [runtime]
tools:
  required: [exec, read]
  optional: [grep, ledger_query, skill_complete]
  denied: []
budget:
  max_tool_calls: 80
  max_tokens: 140000
outputs: [branch_state, style_detection, commit_plan, safety_checks]
consumes: [change_summary, files_changed, verification]
escalation_path:
  branch_state_unclear: exploration
---

# Git Skill

## Intent

Deliver reviewable and recoverable Git history with explicit checkpoints.

## Trigger

Use this skill for any request that includes:

- Commit creation or commit cleanup.
- Rebase, squash, force-push decision, or conflict recovery.
- History lookup such as "who changed this", "when was this added", or "find bad commit".

## Mode Detection (mandatory first step)

Classify request into exactly one mode before running command sequences.

| Pattern                                           | Mode             | Goal                           |
| ------------------------------------------------- | ---------------- | ------------------------------ |
| commit, changes ready, split commits              | `COMMIT`         | Create atomic commits          |
| rebase, squash, cleanup history, update onto main | `REBASE`         | Rewrite history safely         |
| who changed, when added, blame, bisect            | `HISTORY_SEARCH` | Produce evidence about history |

If mode is ambiguous, ask one direct question before proceeding.

## Shared Safety Gate (all modes)

### Step S1: Gather context in parallel

```bash
git status --short
git branch --show-current
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"
git diff --stat
git diff --staged --stat
git log -30 --pretty=format:"%h %s"
```

### Step S2: Emit blocking checkpoint

Do not continue until this is produced.

```text
GIT_CONTEXT
- mode: <COMMIT|REBASE|HISTORY_SEARCH>
- branch: <branch-name>
- upstream: <name|NO_UPSTREAM>
- staged_files: <count>
- unstaged_files: <count>
- local_commits_ahead: <count or unknown>
- dirty_worktree: <yes|no>
```

### Step S3: Enforce branch safety

- Never rewrite `main` or `master`.
- Never force-push without explicit warning.
- Never run destructive history rewrite if branch status is unclear.

## COMMIT Mode

### C1: Detect commit message style (blocking)

Run script first, fallback to manual check only if script fails.

```bash
bash skills/base/git/scripts/detect-commit-style.sh
```

Manual fallback:

1. Inspect `git log -30 --pretty=format:%s`.
2. Language decision: Korean ratio >= 50% => Korean, else English.
3. Style decision:
   - `SEMANTIC`: Conventional Commits-style header in >= 50% commits (e.g., `feat(scope)!: ...`).
   - `SHORT`: <= 3 words in >= 50% commits.
   - otherwise `PLAIN`.

Blocking output:

```text
STYLE_DETECTION
- language: <ENGLISH|KOREAN>
- style: <SEMANTIC|PLAIN|SHORT>
- total_messages: <n>
- semantic_messages: <n>
- short_messages: <n>
- sample_messages:
  1) "<from repo history>"
  2) "<from repo history>"
  3) "<from repo history>"
```

### C1.5: Conventional Commits (style=SEMANTIC)

When `STYLE_DETECTION.style = SEMANTIC`, write commit subjects using [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) to keep history machine-parseable (changelog/versioning) and review-friendly.

Minimum requirement: a valid Subject line. Add a body and footers only when they materially improve reviewability (motivation, migration notes, issue references).

- Header format: `<type>[optional scope][!]: <description>`
- `type`: prefer `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`
- `scope`: optional; use stable package/module/directory identifiers (e.g., `brewva-cli`, `brewva-runtime`, `distribution`)
- `description`: English imperative / present tense; no trailing period; avoid low-signal wording ("update", "misc", "fix bug"); aim for <= 72 chars
- Breaking change: use `!` and add a `BREAKING CHANGE: ...` footer with a concise migration hint
- Issue refs: use git-trailer-style footers (e.g., `Refs: #123`, `Closes: #123`)

Quick reference: `skills/base/git/references/conventional-commits.md`

### C2: Plan atomic commit groups

Default is multiple commits, not one commit.

Minimum commit policy:

- `1-2 files`: 1+ commit.
- `3-4 files`: 2+ commits.
- `5-9 files`: 3+ commits.
- `10+ files`: at least `ceil(file_count / 2)` commits.

Split order:

1. Split by directory/module first.
2. Split by concern second (`logic`, `ui`, `config`, `test`, `docs`).
3. Pair implementation with direct tests in same commit.
4. Order commits by dependency level:
   - level 0: types/constants/utilities
   - level 1: models/schemas
   - level 2: services/business logic
   - level 3: interfaces/controllers
   - level 4: config/infrastructure

Hard rules:

- Any commit with `>=3 files` needs one-line justification.
- If justification is vague ("same feature", "same PR"), split again.
- If two file groups can be reverted independently, they must be separate commits.

### C3: Emit commit plan (blocking)

```text
COMMIT_PLAN
- files_changed: <n>
- planned_commits: <n>
- minimum_required: <n>
- status: <PASS|FAIL>

COMMIT_1
- message: "<style-aligned message>"
- files:
  - <path>
  - <path>
- level: <0..4>
- justification: "<why these files are inseparable>"

COMMIT_2
...

EXECUTION_ORDER
- <commit id> -> <commit id> -> ...
```

If status is `FAIL`, re-plan before staging.

### C4: Execute commit plan

```bash
git add <files-for-commit-1>
git diff --staged --stat
git commit -m "<message>"

git add <files-for-commit-2>
git diff --staged --stat
git commit -m "<message>"
```

Post-commit checks:

```bash
git status --short
git log --oneline -n <planned_commits>
```

## REBASE Mode

### R1: Select rebase strategy

Strategy matrix:

- Current branch is `main/master` => no rewrite, create new commits only.
- Branch has local unpublished commits => aggressive rewrite allowed.
- Branch already pushed => careful rewrite with explicit force-push warning.

### R2: Run rebase workflow

Preferred commands:

```bash
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash "$MERGE_BASE"
```

For base update:

```bash
git fetch origin
git rebase origin/main
```

Conflict protocol:

1. Inspect conflicted files with `git status`.
2. Resolve file-by-file.
3. Stage resolved files and continue:

```bash
git add <resolved-file>
git rebase --continue
```

4. Abort if conflict scope is unclear:

```bash
git rebase --abort
```

### R3: Rebase verification (blocking)

```text
REBASE_REPORT
- strategy: <NEW_COMMITS_ONLY|AGGRESSIVE_REWRITE|CAREFUL_REWRITE>
- conflicts: <none|count>
- rewritten_commits: <n>
- requires_force_push: <yes|no>
- safety_note: "<explicit warning if force push needed>"
```

## HISTORY_SEARCH Mode

### H1: Choose search method

- Exact string lifecycle => `git log -S`.
- Pattern/regex history => `git log -G`.
- Line ownership => `git blame`.
- Regression origin between good/bad states => `git bisect`.

### H2: Execute focused queries

```bash
git log -S "target_string" --oneline -- <path>
git log -G "regex_pattern" --oneline -- <path>
git blame -L <start>,<end> <path>
```

Bisect template:

```bash
git bisect start
git bisect bad
git bisect good <known-good-commit>
# run test, then mark each step:
git bisect good
git bisect bad
git bisect reset
```

### H3: Emit evidence report

```text
HISTORY_REPORT
- question: "<user question>"
- method: <S|G|BLAME|BISECT>
- result_commit: <hash or none>
- confidence: <high|medium|low>
- evidence:
  - "<command output line>"
  - "<command output line>"
```

## Stop Conditions

- Context commands fail repeatedly and branch state cannot be determined.
- Request implies destructive rewrite on protected branch.
- Rebase creates unresolved conflicts after two attempts.
- History search cannot narrow to meaningful candidates.
- Required Git workflow cannot execute in current environment and no meaningful `TOOL_BRIDGE` can be produced.

When stopped, output what was tried and what exact input is needed next.

If execution is blocked by environment/tooling constraints, emit `TOOL_BRIDGE` using
`skills/base/planning/references/executable-evidence-bridge.md` for a human-run recovery script.

## Anti-Patterns (never)

- One giant commit for unrelated files.
- Mixing implementation and unrelated cleanup in one commit.
- Force-pushing without warning.
- Running `git add .` before commit grouping is finalized.
- Using vague commit messages that do not describe one atomic change.

## References

- Rebase decision and recovery guide: `skills/base/git/references/rebase-workflow.md`
- Search command cookbook: `skills/base/git/references/history-search-cheatsheet.md`
- Conventional Commits quick reference: `skills/base/git/references/conventional-commits.md`

## Example

Input:

```text
"I changed 8 files, help me commit cleanly and keep history easy to review."
```

Expected sequence:

1. Run Shared Safety Gate.
2. Run style detection script.
3. Produce `COMMIT_PLAN` with 3+ commits and dependency order.
4. Stage/commit per group.
5. Output post-commit verification summary.
