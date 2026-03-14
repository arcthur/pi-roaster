# Reference: Proposal Boundary

Boundary contract sources:

- Runtime types: `packages/brewva-runtime/src/types.ts`
- Runtime facade: `packages/brewva-runtime/src/runtime.ts`
- Deliberation records: `packages/brewva-deliberation/src/records.ts`
- Deliberation cognition bridge: `packages/brewva-deliberation/src/cognition.ts`
- Deliberation helpers: `packages/brewva-deliberation/src/proposals.ts`
- Deliberation runtime planning: `packages/brewva-deliberation/src/runtime-skills.ts`
- Context composition bridge: `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- Memory curator producer: `packages/brewva-gateway/src/runtime-plugins/memory-curator.ts`
- Broker proposal producer: `packages/brewva-skill-broker/src/extension.ts`

The proposal boundary is the public handoff between deliberation and kernel
commitment.

## Authority Model

- deliberation may propose
- kernel may `accept`, `reject`, or `defer`
- only accepted proposals may create new kernel commitments
- every proposal decision must remain replayable from tape

There is no kernel-owned fallback path that silently recreates missing adaptive
selection behavior.

## Core Objects

### `EvidenceRef`

Minimum fields:

- `id`
- `sourceType`
- `locator`
- `createdAt`

Optional field:

- `hash`

Current source types include:

- `broker_trace`
- `event`
- `ledger`
- `task`
- `truth`
- `workspace_artifact`
- `operator_note`
- `verification`
- `tool_result`

`EvidenceRef` is provenance, not business meaning. It points to why the
proposal exists; it does not itself decide acceptance.

### `ProposalEnvelope`

Fields:

- `id`
- `kind`
- `issuer`
- `subject`
- `payload`
- `evidenceRefs`
- `confidence?`
- `expiresAt?`
- `createdAt`

Current proposal kinds:

- `skill_selection`
- `context_packet`
- `effect_commitment`

### `DecisionReceipt`

Fields:

- `proposalId`
- `decision`
- `policyBasis`
- `reasons`
- `committedEffects`
- `evidenceRefs`
- `turn`
- `timestamp`

`DecisionReceipt` is the commitment-side answer to a proposal. It is the unit
operators and replay logic should inspect when asking what the kernel actually
decided.

## Proposal Kinds

### `skill_selection`

Producer intent:

- broker shortlist
- ranking/judging result
- manual or operator-assisted selection

Accepted effect:

- kernel creates a pending dispatch commitment
- actual skill entry still happens via
  `skill_load`

### `context_packet`

Producer intent:

- curated non-authoritative context prepared outside the kernel
- operator/control-plane cognition artifacts under `.brewva/cognition/*`

Optional payload controls:

- `scopeId`: inject only for the matching context leaf scope
- `packetKey`: let later packets from the same `issuer + scopeId + packetKey`
  replace earlier ones during injection
- `action`: `upsert` (default) or `revoke`; accepted revoke packets act as
  latest-wins tombstones during injection
- `profile`: optional packet profile tag; current built-in profile is
  `status_summary`
- `expiresAt`: keep the packet auditable on tape, but stop injecting it after
  the TTL passes

Accepted effect:

- packet becomes available to deterministic context injection as
  `brewva.context-packets`
- the kernel injects only active packets for the current scope, and collapses
  replacement packets by latest accepted receipt
- accepted `revoke` packets stop the matching packet from injecting without
  deleting tape history
- packet does not become truth/task/ledger state on its own

### `effect_commitment`

Producer intent:

- commitment-posture tool calls that cross the effect authorization boundary
- auditable submission of `local_exec`, `schedule_mutation`, and external side
  effects before runtime execution

Accepted effect:

- kernel records a replayable pending request for the concrete commitment
  proposal
- after operator acceptance, execution may proceed only when the caller resumes
  that exact pending request
- rejected or deferred receipts remain on tape and keep the attempted effect
  replayable without silently re-authorizing it
- the operator desk reconstructs pending / accepted / consumed request state
  from tape events after restart instead of relying on opaque in-memory
  snapshots

## Kernel Decision Rules

Current admission rules are intentionally conservative:

- required identity fields must exist (`id`, `issuer`, `subject`)
- at least one `EvidenceRef` is required
- expired proposals are rejected
- unknown skills are rejected
- empty `skill_selection` proposals are rejected or deferred, not fabricated
- malformed `context_packet` proposals are rejected
- reserved built-in issuers must obey their declared boundary policy

Current reserved issuer policy:

- `brewva.skill-broker`
  - allowed kinds: `skill_selection`
  - requires `broker_trace` evidence
- `brewva.extensions.debug-loop`
  - allowed kinds: `context_packet`
  - `context_packet` requires scoped `status_summary` packets with `packetKey`,
    `expiresAt`, and `event` / `workspace_artifact` / `operator_note` evidence
- `brewva.extensions.memory-curator`
  - allowed kinds: `context_packet`
  - requires `workspace_artifact` evidence
  - requires `packetKey` and `expiresAt`

Decision meanings:

- `accept`: commitment created
- `reject`: proposal invalid or disallowed
- `defer`: proposal is well-formed enough to record, but commitment is not made
  yet

## Direct Commit Boundary

Not every cross-module decision is a proposal.

Current direct-commit paths include:

- explicit cascade starts (`runtime.skills.startCascade(...)`)
- debug-loop retry scheduling
- broker-owned cascade planning after accepted `skill_selection`

Use the proposal boundary only when the action crosses a real admission/audit
boundary: broker skill selection, external/non-authoritative context
injection, or commitment-posture effect execution.

## Tape And Event Mapping

Every proposal round should leave this replayable shape:

- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`

The receipt event stores both the normalized proposal and the kernel decision so
the boundary remains auditable after restart or replay.

`runtime.proposals.list(sessionId, query?)` returns proposal records newest
first by receipt timestamp. Deliberation helpers may still sort defensively when
they collapse latest-wins packet keys, but the runtime surface itself treats the
latest receipt as index `0`.

For commitment-posture effects, the same domain now exposes the operator desk
surface:

- `runtime.proposals.listPendingEffectCommitments(sessionId)`
- `runtime.proposals.decideEffectCommitment(sessionId, requestId, input)`
- `runtime.tools.start({ ..., effectCommitmentRequestId })`

This keeps the approval queue and the receipt-bearing proposal history in one
governance namespace instead of creating a second parallel authority path.
The queue is replay-first: pending and approved request state is rebuilt from
`effect_commitment_approval_*` events plus the recorded proposal/receipt pair.

## Producer Guidelines

Deliberation/experience producers should:

- keep `issuer` stable and specific
- submit concrete evidence references
- treat `defer` as a real outcome, not an error path
- avoid encoding hidden authority into `payload`

Kernel code should:

- never mutate authoritative state without a receipt-worthy reason
- keep `policyBasis` and `reasons` readable by operators
- prefer explicit deferral over opaque fallback behavior
