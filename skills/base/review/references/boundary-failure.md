# Boundary and Failure Reference

## Purpose

Load this reference when the `performance` lane is activated in `DEEP` mode.

## Boundary checks

- Null/undefined and optional handling:
  - unchecked nullable values in critical flows
  - truthy/falsy misuse where `0`, `""`, or `false` are valid
- Collection boundaries:
  - empty collection assumptions
  - unchecked index access
- Numeric boundaries:
  - division by zero
  - unsafe integer ranges
  - off-by-one loop and pagination errors

## Failure and recovery checks

- Exception handling:
  - swallowed errors
  - broad catch with no typed handling path
  - leaked internal details in user-facing errors
- External dependency failures:
  - missing timeout, retry policy, or fallback
  - retry without idempotency protection
- Degradation and recovery behavior:
  - no explicit behavior for partial failure
  - no signal path for operators (logs/metrics/alerts)

## Performance risk checks

- N+1 query or one-by-one I/O pattern
- repeated expensive computation in hot path
- unbounded memory growth
- lack of batching or cache strategy in repeated reads

## Evidence expectations

Each finding should state:

- triggering boundary or failure condition
- observed/expected incorrect behavior
- impact under load or production conditions
- minimal fix with verification suggestion
