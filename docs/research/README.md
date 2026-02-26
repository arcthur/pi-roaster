# Research Docs (Incubation Layer)

`docs/research/` is the incubation layer for cross-cutting ideas that are not
yet stable enough for `docs/architecture/` or `docs/reference/`.

## When to add a research note

- A decision spans multiple packages or runtime domains.
- The team needs to compare alternatives before locking a contract.
- Validation criteria are known, but implementation is still evolving.

## Required metadata for each research note

- `Status`: `proposed` | `active` | `promoted` | `archived`
- `Owner`: responsible team or maintainer group
- `Last reviewed`: date in `YYYY-MM-DD`
- `Promotion target`: destination stable document(s)

## Required sections for each research note

- Problem statement and scope boundaries
- Hypotheses or decision options
- Source anchors (code and docs paths)
- Validation signals (tests, metrics, or operational checks)
- Promotion criteria and destination docs

## Promotion workflow

1. Track open questions and hypotheses in `docs/research/*.md`.
2. Validate with code changes, tests, and operational evidence.
3. Promote accepted decisions into stable docs:
   - `docs/architecture/` for design/invariant decisions
   - `docs/reference/` for public contracts
   - `docs/journeys/` for operator workflows
4. Keep research pages as concise status pointers or archive them.

## Active notes

- `docs/research/roadmap-notes.md`
