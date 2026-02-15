# Rebase Workflow Reference

## Goal
Rewrite branch history into reviewable atomic commits while preserving correctness.

## Safety Checklist
Run this checklist before any rewrite:

```bash
git status --short
git branch --show-current
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"
git log --oneline -n 20
```

Stop if any of these is true:
- Current branch is `main` or `master`.
- Working tree contains unknown/unrelated files and grouping is unclear.
- Upstream status is unknown and force-push risk cannot be evaluated.

## Strategy Matrix

| Branch State | Recommended Strategy | Force Push |
| --- | --- | --- |
| Local branch, not pushed | Aggressive rewrite allowed | Not required |
| Pushed feature branch | Careful rewrite with warning | Required |
| Protected branch (`main/master`) | No rewrite | Never |

## Common Rebase Flows

### 1) Autosquash local fixups
Use when commits already exist but need clean structure.

```bash
git commit --fixup <target-commit>
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash "$MERGE_BASE"
```

### 2) Rebase feature branch onto updated main
Use when branch is behind latest base.

```bash
git fetch origin
git rebase origin/main
```

### 3) Rebuild local branch from merge-base
Use only when local history is messy and unpublished.

```bash
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)
git reset --soft "$MERGE_BASE"
# re-commit in atomic groups
```

## Conflict Resolution Protocol
1. Identify conflicts:
```bash
git status
```
2. Resolve each conflicted file.
3. Stage resolved files:
```bash
git add <resolved-file>
```
4. Continue rebase:
```bash
git rebase --continue
```
5. Abort if conflict scope is too broad:
```bash
git rebase --abort
```

## Verification After Rebase

```bash
git status --short
git log --oneline -n 20
```

Recommended behavioral checks:
- Run targeted test command for touched modules.
- Run broader checks if critical paths were rewritten.

## Force Push Decision
Use force push only when all are true:
- Branch was rewritten.
- Branch is not protected.
- Push target is your feature branch.
- You emitted explicit safety warning.

Command:
```bash
git push --force-with-lease
```

Prefer `--force-with-lease` over plain `--force`.
