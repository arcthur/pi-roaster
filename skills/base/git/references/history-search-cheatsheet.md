# History Search Cheatsheet

## Choose Search Method

| Question Type | Command Family | Why |
| --- | --- | --- |
| "When was this string added or removed?" | `git log -S` | Tracks exact string count changes |
| "When did code matching this pattern change?" | `git log -G` | Regex-based history search |
| "Who touched this line?" | `git blame` | Line ownership and origin commit |
| "Which commit introduced this regression?" | `git bisect` | Binary search on history |

## Pickaxe (`-S`) Examples

```bash
git log -S "featureFlagX" --oneline
git log -S "functionName(" --oneline -- src/module.ts
git log -S "API_KEY" --patch -- src/config.ts
```

Tips:
- Add `--patch` when you need the actual diff context.
- Scope with `-- <path>` to reduce noise.

## Regex History (`-G`) Examples

```bash
git log -G "TODO\\(" --oneline
git log -G "^export\\s+function\\s+buildPlan" --oneline -- src
git log -G "try\\s*\\{" --patch -- src/runtime.ts
```

Tips:
- Use escaped regex patterns to avoid shell interpretation issues.
- Pair with `--patch` for evidence output.

## Blame Examples

```bash
git blame src/runtime.ts
git blame -L 120,170 src/runtime.ts
git blame -w src/runtime.ts
```

Useful flags:
- `-L start,end`: limit line range.
- `-w`: ignore whitespace-only edits.

## Bisect Workflow

```bash
git bisect start
git bisect bad
git bisect good <known-good-commit>
# run test or repro command, then:
git bisect good
git bisect bad
git bisect reset
```

Use bisect only when:
- You have one known good commit.
- You have one reproducible bad state.
- You can evaluate each step quickly.

## Evidence Reporting Template

```text
HISTORY_REPORT
- question: "<what user asked>"
- selected_method: <S|G|BLAME|BISECT>
- key_commit: <hash>
- evidence_lines:
  - "<log/blame output>"
  - "<log/blame output>"
- confidence: <high|medium|low>
```
