# Eval Safe Mode Reference

Use `eval` only when built-in commands cannot express the extraction or check.

## Safe Usage Ladder

1. Prefer `get/snapshot/find` commands first.
2. Use `eval '...'` only for simple one-line expressions.
3. Use `eval --stdin` for multiline or quote-heavy JavaScript.
4. Use `eval -b` for generated scripts.

## Recommended Patterns

Simple:

```bash
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'
```

Complex via stdin:

```bash
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("a"))
    .map(a => ({ text: a.textContent?.trim(), href: a.href }))
)
EVALEOF
```

Generated script via base64:

```bash
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll(\"a\")).map(a => a.href)' | base64)"
```

## Why Quoting Breaks

Shell parsing can alter the JavaScript before it reaches the browser runtime:

- nested quotes
- history expansion with `!`
- command substitution with `$()` or backticks

`--stdin` and `-b` bypass most of these issues.

## Output Discipline

- Return compact JSON strings when extraction is consumed downstream.
- Avoid dumping full DOM or large arrays; cap output by selecting only needed keys.

## Anti-Patterns

- Using `eval` for actions already covered by built-in commands.
- Running unbounded DOM traversals on large pages.
- Embedding secrets directly in evaluated scripts.
