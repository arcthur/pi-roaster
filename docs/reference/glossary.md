# Reference: Glossary

- Skill: an executable capability unit loaded from `skills/**/SKILL.md`
- Contract: a skill policy defining tool permissions, budgets, and required outputs
- Ledger: append-only evidence stream for tool outcomes
- Verification Gate: completion policy that checks required evidence
- Checkpoint: machine-generated tape baseline event used to accelerate replay
- Snapshot (rollback): per-file pre-mutation copy used by `rollback_last_patch`; not a runtime session-state source of truth
- Replay: reconstruction of session history from structured events
- PatchSet: tracked file change set used for rollback
- Context Budget: policy for context injection and compaction
- Cost Budget: threshold policy for session and skill spend
- Viewport: compact, file-grounded context block injected to guide edits
- SNR (Signal-to-Noise Ratio): heuristic score used to judge viewport quality
- Channel Gateway: external channel ingress/egress gateway used by `--channel` mode
- Gateway (Control Plane): local daemon exposed via `brewva gateway ...`, providing a typed WebSocket API to control-plane clients
