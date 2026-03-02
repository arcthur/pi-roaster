---
name: brewva-self-improve
description: Capture learnings, errors, and corrections to enable continuous improvement. Use when a command fails, user corrects the agent, a knowledge gap is discovered, or a better approach emerges. Also review learnings before major tasks.
version: 1.0.0
stability: stable
tier: project
tags: [learning, self-improvement, feedback, promotion, skill-extraction]
anti_tags: []
tools:
  required: [read, grep]
  optional: [exec, edit, skill_load, skill_complete]
  denied: []
budget:
  max_tool_calls: 40
  max_tokens: 80000
outputs: [learning_entry, error_entry, feature_entry, promotion_action, skill_scaffold]
consumes: [root_cause, fix_description, evidence, verification]
escalation_path:
  learning_unclear: exploration
  recurring_pattern: planning
---

# Brewva Self-Improve Skill

## Objective

Close the feedback loop between agent sessions and project knowledge. Capture non-obvious
discoveries, errors, and corrections into structured logs, then promote high-value
learnings into permanent project knowledge (`AGENTS.md`, skills, docs).

Learnings are stored in `.brewva/learnings/` **in the target user's workspace** (not in
the Brewva source repo). Templates live in `assets/` and ship with this skill.
Run `scripts/setup.sh` to initialize learnings in a new workspace.

This skill integrates with Brewva's existing runtime artifacts (`.orchestrator/`) to
correlate learnings with session evidence when applicable.

## Trigger

Use this skill when:

- A command or operation fails unexpectedly
- User corrects the agent ("No, that's wrong...", "Actually...")
- A knowledge gap is discovered (outdated docs, wrong assumption)
- A better approach is found for a recurring task
- User explicitly asks to log, save, or remember something
- Starting a major task (review existing learnings first)
- A learning has recurred enough to warrant skill extraction

## Detection Signals

### Corrections (→ learning, category `correction`)

- "No, that's wrong..."
- "Actually, you should..."
- "That's not how this project works"

### Knowledge Gaps (→ learning, category `knowledge_gap`)

- Agent provides outdated information
- Documentation referenced is stale
- API/behavior differs from assumption

### Best Practices (→ learning, category `best_practice`)

- A simpler approach replaces a complex one
- A non-obvious pattern proves reliable
- A convention is discovered through trial and error

### Errors (→ error entry)

- Command returns non-zero exit code
- Exception or stack trace in output
- Unexpected output or timeout
- `bun test` / `bun run typecheck` failure patterns

### Feature Requests (→ feature entry)

- "Can you also...", "I wish you could..."
- "Is there a way to...", "Why can't you..."

## Logging Format

### Learning Entry

Append to `.brewva/learnings/LEARNINGS.md`:

```markdown
## [LRN-YYYYMMDD-XXX] category

**Logged**: ISO-8601 timestamp
**Priority**: low | medium | high | critical
**Status**: pending
**Area**: runtime | tools | extensions | cli | gateway | infra | tests | docs | config | skills

### Summary

One-line description

### Details

Full context: what happened, what was wrong, what's correct

### Suggested Action

Specific fix or improvement

### Metadata

- Source: conversation | error | user_feedback
- Related Files: path/to/file.ext
- Session: <sessionId> (if runtime artifact available)
- Tags: tag1, tag2
- See Also: LRN-XXXXXXXX-XXX (if related to existing entry)
- Pattern-Key: category.subcategory (optional, for recurring tracking)
- Recurrence-Count: 1 (optional)

---
```

### Error Entry

Append to `.brewva/learnings/ERRORS.md`:

```markdown
## [ERR-YYYYMMDD-XXX] component_name

**Logged**: ISO-8601 timestamp
**Priority**: high
**Status**: pending
**Area**: runtime | tools | extensions | cli | gateway | infra | tests | docs | config

### Summary

Brief description of what failed

### Error
```

Actual error message or output

```

### Context
- Command/operation attempted
- Input or parameters
- Environment details if relevant

### Suggested Fix
What might resolve this

### Metadata
- Reproducible: yes | no | unknown
- Related Files: path/to/file.ext
- Session: <sessionId> (if available)
- See Also: ERR-XXXXXXXX-XXX (if recurring)

---
```

### Feature Request Entry

Append to `.brewva/learnings/FEATURE_REQUESTS.md`:

```markdown
## [FEAT-YYYYMMDD-XXX] capability_name

**Logged**: ISO-8601 timestamp
**Priority**: medium
**Status**: pending
**Area**: runtime | tools | extensions | cli | gateway | skills

### Requested Capability

What the user wanted

### User Context

Why they needed it

### Complexity Estimate

simple | medium | complex

### Suggested Implementation

How this could be built

### Metadata

- Frequency: first_time | recurring
- Related Features: existing_feature_name

---
```

## ID Generation

Format: `TYPE-YYYYMMDD-XXX`

- TYPE: `LRN` (learning), `ERR` (error), `FEAT` (feature)
- YYYYMMDD: Current date
- XXX: Sequential number starting from `001`, or random 3-char alphanumeric

Scan existing entries in the target file to avoid ID collisions.

## Area Tags (Brewva-specific)

| Area         | Scope                                                          |
| ------------ | -------------------------------------------------------------- |
| `runtime`    | `packages/brewva-runtime/` — facade, services, config          |
| `tools`      | `packages/brewva-tools/` — tool registry, tool implementations |
| `extensions` | `packages/brewva-extensions/` — hook wiring, SDK bridge        |
| `cli`        | `packages/brewva-cli/` — modes, session, entrypoint            |
| `gateway`    | `packages/brewva-gateway/` — daemon, supervisor, websocket     |
| `infra`      | CI/CD, distribution, build scripts                             |
| `tests`      | Test files, test utilities, coverage                           |
| `docs`       | Documentation, reference, guides                               |
| `config`     | Configuration, defaults, normalization                         |
| `skills`     | Skill definitions, scripts, references                         |

## Priority Guidelines

| Priority   | When                                                      |
| ---------- | --------------------------------------------------------- |
| `critical` | Blocks core functionality, data loss risk, security issue |
| `high`     | Significant impact, common workflow, recurring issue      |
| `medium`   | Moderate impact, workaround exists                        |
| `low`      | Minor, edge case, nice-to-have                            |

## Workflow

### Step 1: Detect learning signal

Evaluate the current interaction against detection signals above. If a signal is present,
proceed. If uncertain, log with `low` priority rather than skipping.

### Step 2: Check for duplicates

Search existing entries in `.brewva/learnings/` for related content:

```bash
rg -i "keyword" .brewva/learnings/
```

If a related entry exists, add a `See Also` link and consider bumping its priority.

### Step 3: Log the entry

Append the formatted entry to the appropriate file. Include:

- Accurate timestamp and sequential ID
- Correct area tag based on the Brewva package affected
- Session ID from `.orchestrator/` if the learning came from runtime analysis
- `See Also` links to any related entries found in Step 2

### Step 4: Evaluate promotion readiness

After logging, check if this entry qualifies for promotion:

- Has `See Also` links to 2+ similar entries? → candidate for skill extraction
- Is `high`/`critical` priority and `resolved`? → candidate for `AGENTS.md` promotion
- Is a non-obvious project convention? → candidate for `AGENTS.md`

If promotion is warranted, proceed to Step 5. Otherwise, stop.

### Step 5: Promote or extract

Choose the appropriate action:

- **Promote to AGENTS.md**: run `scripts/promote.sh <id> agents`
- **Extract as new skill**: run `scripts/extract-skill.sh <skill-name>`
- **Promote to docs**: manually add to the appropriate `docs/reference/` file

Update the original entry with `**Status**: promoted` and the target.

See `references/promotion-targets.md` for the full target matrix.

### Step 6: Resolve entries

When an issue from `.brewva/learnings/` is fixed, update the entry:

1. Change `**Status**: pending` → `**Status**: resolved`
2. Add resolution block:

```markdown
### Resolution

- **Resolved**: ISO-8601 timestamp
- **Commit/PR**: reference
- **Notes**: what was done
```

## Hook Integration

Enable automatic reminders through agent hooks.

### Activator Hook (UserPromptSubmit)

Injects a lightweight reminder (~60 tokens) after each prompt to evaluate learning signals.

Script: `skills/project/brewva-self-improve/scripts/activator.sh`

### Error Detector Hook (PostToolUse → Bash)

Detects command failures and suggests logging to `.brewva/learnings/ERRORS.md`.

Script: `skills/project/brewva-self-improve/scripts/error-detector.sh`

### Setup

Add to `.claude/settings.json` or equivalent:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "./skills/project/brewva-self-improve/scripts/activator.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./skills/project/brewva-self-improve/scripts/error-detector.sh"
          }
        ]
      }
    ]
  }
}
```

## Orchestrator Correlation

When a learning originates from runtime behavior analysis, include:

- **Session ID**: from `.orchestrator/events/<sessionId>.jsonl`
- **Ledger reference**: relevant `evidence.jsonl` row IDs
- **Turn number**: if the issue occurred at a specific turn

This enables future tracing from learning → session evidence → root cause.

Use `skills/project/brewva-session-logs/SKILL.md` for detailed JSONL query recipes.

## Stop Conditions

- Learning signal is ambiguous and user has not confirmed — ask before logging.
- Duplicate entry already exists with identical content — link with `See Also` instead.
- The learning is session-specific trivia with no reuse value — skip.
- Promotion target already contains equivalent guidance — skip promotion.

## Anti-Patterns (forbidden)

- Logging trivial or obvious facts that any agent would know.
- Creating duplicate entries instead of linking with `See Also`.
- Promoting unverified or speculative learnings to `AGENTS.md`.
- Extracting a skill from a single unresolved learning.
- Modifying `.orchestrator/` artifacts — this skill only reads them.
- Logging without checking for existing related entries first.
- Skipping the area tag or using generic "backend" instead of Brewva-specific areas.

## Examples

### Example A — Error captured and logged

Input: `bun run typecheck` fails with an unexpected type error in `brewva-extensions`.

Expected flow:

1. Detect error signal (non-zero exit code from typecheck).
2. Search `.brewva/learnings/ERRORS.md` for related typecheck entries.
3. Log `[ERR-20260226-001]` with area `extensions`, priority `high`.
4. Include the error message, command, and suggested fix.
5. If related to a previous error, add `See Also` link.

### Example B — User correction promoted

Input: User says "Actually, Brewva uses `bun` not `npm` for all workspace operations."

Expected flow:

1. Detect correction signal ("Actually...").
2. Log `[LRN-20260226-001]` with category `correction`, area `config`, priority `medium`.
3. Evaluate: this is a project convention affecting all agent sessions.
4. Promote to `AGENTS.md` under CONVENTIONS.
5. Update entry: `**Status**: promoted`, `**Promoted**: AGENTS.md`.

### Example C — Recurring pattern extracted as skill

Input: Third instance of a Bun-specific test isolation pattern being discovered.

Expected flow:

1. Log `[LRN-20260226-003]` with `See Also` links to 2 previous entries.
2. Evaluate: 3 related entries, resolved, broadly applicable → extract as skill.
3. Run `scripts/extract-skill.sh bun-test-isolation`.
4. Fill in the generated `SKILL.md` scaffold with content from all 3 learnings.
5. Update all 3 entries: `**Status**: promoted_to_skill`, `**Skill-Path**: skills/base/bun-test-isolation`.
