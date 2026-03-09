# Projection Patterns

## Intent

Projection is not merely "reading less." It is the act of shrinking the input into the smallest
auditable slice that still preserves contract correctness.

Each projection should answer three questions:

- why these inputs must remain
- why the excluded inputs are safe to drop
- whether the remaining slice is still sufficient for the contract

## File Scope Projection

Use this mode for repositories, configuration trees, log directories, and similar file-based inputs.

Preferred sequence:

1. narrow the candidate set using path, filename, extension, or search terms
2. read only the matched targets
3. use `grep` to locate segments before falling back to broader reads

Prefer to keep:

- files that directly map to the target schema
- the nearest documentation that explains field semantics
- any inputs explicitly named by the task

Prefer to exclude:

- historical archives
- modules unrelated to the target fields
- pure UI, navigation, styling, or marketing content

Blocking output:

```text
ZCA_SCOPE
- domain: "<target domain>"
- included:
  - "<file or slice>"
- excluded:
  - item: "<dropped file>"
    reason: "<why>"
- reduction_estimate: "<rough ratio>"
```

## JSON Subtree Projection

Use this mode for large API responses, event payloads, and configuration snapshots.

Rules:

- keep only the subtree required by the target schema
- explicitly remove pagination, metadata, debug, trace, and request wrappers
- when a support field explains another field, keep only the minimum dependency chain, not the entire root object

Common keep patterns:

- `data.items`
- `payload.records`
- `result.summary`

Common exclusion patterns:

- `meta`
- `pagination`
- `request`
- `trace`
- `debug`

## Task And Ledger State Projection

Use this mode for current task state, recent evidence, blockers, and bounded execution context.

Prioritize:

- current phase, blockers, and active items from `task_view_state`
- recent entries from `ledger_query` that directly inform the active contract

Exclude:

- long-resolved blockers
- stale tool output unrelated to the current extraction contract
- broad historical narrative with no direct contract impact

## Exclusion Discipline

Every projection must leave behind an exclusion record.

Minimum requirements:

- what was excluded
- why it was excluded
- how much input size was removed

If you cannot justify the exclusion, the projection is not stable enough.

## Size Policy

If the projected input is still too large, do not immediately increase budget.

Apply this order:

1. narrow the file or field scope again
2. collapse repetition, whitespace, and irrelevant metadata
3. keep only summaries, hashes, and counts
4. if needed, generate a temporary artifact through `exec` and retain only an `artifact_ref`

## Anti-Patterns

- reading everything first and calling it projection afterward
- omitting an exclusion log
- carrying the entire source forward because of uncertainty
- treating DOM subtree projection as the default v1 path

