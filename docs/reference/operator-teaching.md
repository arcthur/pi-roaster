# Reference: Operator Teaching

Primary implementation surfaces:

- `packages/brewva-tools/src/cognition-note.ts`
- `packages/brewva-deliberation/src/cognition.ts`

## Role

Operator teaching is the explicit write path for high-signal external cognition
input.

It does not mutate kernel truth, task, ledger, or tape state directly. It
writes append-only cognition artifacts that may later be rehydrated through
`MemoryCurator` and admitted by the proposal boundary.

## Supported Kinds

- `reference`
  - durable project knowledge or operator-authored notes
- `procedure`
  - reusable operator-authored work patterns and recommendations
- `episode`
  - bounded process-memory notes about how a line of work evolved

## Storage Mapping

- `reference` -> `.brewva/cognition/reference/`
- `procedure` -> `.brewva/cognition/reference/`
- `episode` -> `.brewva/cognition/summaries/`

This follows the same architecture rule as the curator:

`storage lanes are not retrieval strategies`

For `episode` notes, an operator may also provide an explicit `sessionScope`
when the note should participate in same-session rehydration instead of staying
as a workspace-only external note.

## Operations

- `record`
  - append a new operator-authored cognition artifact
  - reject duplicate semantic names for the same `kind`
- `supersede`
  - append a newer artifact with the same semantic name instead of editing an
    existing file in place
  - older operator-authored versions remain on disk for auditability, while
    retrieval and listing collapse them to the newest semantic version
- `list`
  - inspect recent operator-authored cognition artifacts only
  - exclude system-generated memory artifacts

## Boundary Rules

Operator teaching may:

- create or supersede external cognition artifacts
- improve future memory quality with explicit human guidance
- remain visible through audit events such as `cognition_note_written`
- provide workspace-scoped `reference` / `procedure` guidance and explicit
  operator-authored `episode` notes without mutating kernel state

Operator teaching may not:

- bypass proposal admission
- rewrite kernel commitments
- edit existing cognition files in place
