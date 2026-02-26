# Semantic Locators Reference

Use semantic locators when refs are unavailable, stale, or repeatedly unstable.

## When to Switch from Refs

Switch if one of the following persists after re-snapshot:

- dynamic UI replaces nodes frequently
- interaction target is rendered late or conditionally
- accessibility tree is sparse for interactive controls

## Locator Patterns

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

## Selection Priority

1. `find role ... --name ...` for robust, intent-driven matching.
2. `find label` for form fields.
3. `find testid` for app-owned stable hooks.
4. `find text` or `find placeholder` only when stronger anchors are unavailable.

## Integration with Ref Workflow

1. Start with `snapshot -i` and refs.
2. Use semantic locator as fallback for the failing step.
3. Re-snapshot and return to refs after major DOM changes.

## Pitfalls

- Over-broad text selectors can match multiple elements.
- Placeholder text may vary by locale.
- Test IDs are robust only if front-end keeps them stable.
