# Security Baseline Reference

Use this reference when browser automation touches untrusted pages, credentials, or high-impact actions.

## Recommended Baseline

Enable these controls before navigation:

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"
export AGENT_BROWSER_ACTION_POLICY=./policy.json
export AGENT_BROWSER_MAX_OUTPUT=50000
```

## Why Each Control Matters

- `AGENT_BROWSER_CONTENT_BOUNDARIES`: clearly marks page-originated content to reduce prompt-injection confusion.
- `AGENT_BROWSER_ALLOWED_DOMAINS`: blocks unexpected navigation and cross-domain subresource calls.
- `AGENT_BROWSER_ACTION_POLICY`: enforces allowlist-style action gating.
- `AGENT_BROWSER_MAX_OUTPUT`: caps output size to prevent context flooding.

## Minimal Policy File

```json
{
  "default": "deny",
  "allow": ["navigate", "snapshot", "click", "scroll", "wait", "get"]
}
```

## Operational Checklist

1. Add required CDN and API domains to allowlist.
2. Keep destructive actions denied unless explicitly required.
3. Run `snapshot -i` and verify domain/URL before form submission.
4. Keep output caps enabled for large and dynamic pages.

## Common Failure Modes

- Allowed page fails to load: missing CDN domain in allowlist.
- Action blocked unexpectedly: action policy too strict for current flow.
- Auth still risky: auth vault operations may bypass action policy; domain allowlist still applies.
