# Migration Priority Matrix

## Objective

Prioritize migration by risk and leverage so low-value work does not block the critical path.

## P0 (must land first)

| Item                                                                      | Risk | Expected Outcome                                               |
| ------------------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| Upgrade Verification Gate from evidence-presence to command-backed checks | High | `standard/strict` levels execute real verification commands    |
| Enforce Skill outputs completion lifecycle                                | High | unfinished active skills are detected and cannot silently pass |

Completion criteria:

- observable behavior change is present
- reproducible verification evidence exists
- rollback path is defined

## P1 (after P0 stabilization)

| Item                                                                                         | Risk        | Expected Outcome                                                |
| -------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| Harden context arena control plane (adaptive zones, floor_unmet cascade, SLO degradation)    | Medium-High | deterministic context behavior under pressure and long sessions |
| Align LSP evidence quality labeling with actual tool semantics                               | Medium      | evidence can distinguish heuristic vs native quality            |
| Complete memory and parallel result lifecycle (including external recall boundary semantics) | Medium      | cross-session memory and worker output chain are closed         |

Completion criteria:

- no regression in existing interfaces
- critical paths have regression verification

## P2 (hardening and governance)

| Item                                        | Risk   | Expected Outcome                           |
| ------------------------------------------- | ------ | ------------------------------------------ |
| Ledger checkpoint/compaction                | Medium | long-running sessions remain size-bounded  |
| Skill regression test harness               | Medium | high-value skills are repeatably validated |
| Sanitization hardening and secret redaction | Medium | lower prompt-injection and data-leak risk  |

Completion criteria:

- minimum viable implementation is usable
- implementation is minimally invasive to existing flow

## Decision Rules

1. Always execute in P0 -> P1 -> P2 order.
2. Within same priority, complete dependency prerequisites first.
3. A task is never marked done without executable verification.

## Minimum Delivery Packet

Each completed task must include:

- change summary (what changed)
- verification evidence (how it was proven)
- residual risk statement (what remains uncovered)
