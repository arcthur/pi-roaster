# Diff Verification Reference

Use diff verification for flows where state change must be proven, not inferred.

## Snapshot Diff Workflow

Best for validating semantic page changes after clicks, submits, or filters.

```bash
agent-browser snapshot -i
agent-browser click @e2
agent-browser diff snapshot
```

Interpretation:

- `+` indicates added nodes/content.
- `-` indicates removed nodes/content.

## Visual Diff Workflow

Best for layout/styling regressions or pixel-level checks.

```bash
agent-browser screenshot baseline.png
# later or after update
agent-browser diff screenshot --baseline baseline.png
```

Expected artifact:

- mismatch percentage
- diff image with changed pixels highlighted

## Cross-Environment Diff

Best for staging vs production parity checks.

```bash
agent-browser diff url https://staging.example.com https://prod.example.com --screenshot
```

## Evidence Contract Integration

When using diff, include it in output:

```text
ACTION_LOG
- step: "verify post-submit changes"
  result: "success"
  evidence: "diff snapshot: +3 nodes, -1 node"
```

## Rules

1. Always take a fresh baseline before the action under test.
2. Re-snapshot after navigation before running `diff snapshot`.
3. Prefer snapshot diff for behavior, screenshot diff for visuals.
