# Conventional Commits v1.0.0 Quick Reference

Goal: make commit subjects machine-parseable (changelog/versioning/release notes) while staying review-friendly.

Spec: [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

## 1) Minimal format (Subject-only is acceptable)

```text
<type>[optional scope][!]: <description>
```

Guidelines:
- Write `description` in English imperative / present tense (e.g., "add", "support", "remove", "prevent").
- No trailing period; avoid low-signal wording ("update", "misc", "fix bug").
- Keep the subject around ~72 characters when practical for terminal and review tooling.

## 2) Recommended `type` set (keep consistent)

```text
feat:     user-facing feature
fix:      user-facing bug fix
refactor: behavior-preserving refactor
perf:     performance improvement
docs:     documentation-only change
test:     add/update tests
build:    build system / dependencies
ci:       CI configuration
chore:    non-product change (tooling, cleanup)
style:    formatting only (no behavior change)
revert:   revert a previous commit
```

Note: Conventional Commits does not mandate a fixed `type` set, but consistency is usually more valuable than completeness.

## 3) Choosing `scope` (optional, recommended)

Use stable, searchable identifiers:
- Workspace package names (e.g., `roaster-cli`, `roaster-runtime`, `roaster-tools`)
- Or module/directory names (e.g., `distribution`, `docs`, `script`)

```text
feat(roaster-cli): support --json output
fix(roaster-runtime): avoid snapshot corruption on retry
docs(distribution): add troubleshooting guide
```

## 4) Breaking changes (must be explicit)

Two equivalent ways:
- Use `!` in the header: `type(scope)!: ...` or `type!: ...`
- Use a `BREAKING CHANGE:` footer trailer

Recommended: use `!` in the header, and include a `BREAKING CHANGE:` footer that states what broke and the minimal migration.

```text
refactor(roaster-runtime)!: replace legacy ledger writer

BREAKING CHANGE: ledger entry IDs are now UUIDv7; re-run migrations with `bun run ledger:migrate`.
```

## 5) Body and footers (as needed)

Use the body when it materially improves reviewability (why, validation steps, impact scope, migration notes, issue references):

```text
feat(roaster-tools): add AST helper for import rewrites

This adds a helper used by the refactor pipeline to safely rewrite imports across packages.

Refs: #123
Closes: #456
```

Prefer git-trailer-style footers (`Key: Value`) so tooling can parse them.
