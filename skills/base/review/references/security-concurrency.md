# Security and Concurrency Reference

## Purpose

Load this reference only when the `security` lane is activated in `DEEP` mode.

## Security checks

- Input and output safety:
  - XSS, SQL/NoSQL/command injection
  - SSRF and path traversal
  - unsafe object merge / prototype pollution risks
- AuthN/AuthZ:
  - missing ownership or tenancy checks
  - trusting client-provided role, scope, or tenant values
  - new endpoint without explicit authorization guard
- Sensitive data:
  - secrets or tokens in logs, errors, or configs
  - overexposed payloads with PII
- Runtime abuse surface:
  - missing rate limit / timeout / retry boundaries
  - unbounded loops or resource growth paths

## Concurrency checks

- shared state access without synchronization or isolation boundaries
- check-then-act (TOCTOU) patterns in file, auth, or balance workflows
- read-modify-write flows without transaction or version guards
- non-idempotent retries that can duplicate side effects
- event-ordering assumptions without explicit sequencing guarantees

## Evidence expectations

Each finding should provide:

- concrete code location
- failure or exploit scenario
- impact surface
- minimal safe fix direction

## Common high-risk patterns

```text
if (!exists(key)) { create(key) }         # TOCTOU

const v = read(key); write(key, v + 1)    # read-modify-write race

if (user.balance >= amount) debit(user)   # check-then-act without lock/txn
```
