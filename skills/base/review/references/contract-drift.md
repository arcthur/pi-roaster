# Contract Drift Reference

## Purpose

Load this reference when the `architecture` lane is activated in `DEEP` mode.

## Scope

Review contract compatibility across:

- public APIs (HTTP/GraphQL/gRPC)
- internal module interfaces
- event schemas and message formats
- persistence schemas and migration boundaries

## Drift checks

- Backward compatibility:
  - removed or renamed fields without migration path
  - changed default semantics for existing consumers
  - stricter validation that breaks prior valid inputs
- Behavioral compatibility:
  - response shape changed while status code is unchanged
  - ordering semantics changed without explicit contract update
  - idempotency or retry guarantees altered
- Version and rollout safety:
  - no version gate for breaking behavior
  - producer/consumer deployed out of order risk
  - missing rollback strategy for schema-dependent changes

## Evidence expectations

Each finding should include:

- contract before/after delta
- affected consumers and blast radius
- rollout risk under partial deployment
- minimal migration or compatibility strategy

## Decision hints

- Any unguarded breaking contract change on an active consumer path should be at least `P1`.
- If external consumer impact is unknown, lower confidence and require follow-up evidence.
