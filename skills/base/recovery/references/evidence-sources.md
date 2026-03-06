# Evidence Sources Reference

Load this reference when `recovery` lacks a clean blocker packet or when the
current evidence is too weak to justify a recovery decision.

## Evidence Priority

Prefer existing durable artifacts before new exploration:

1. task ledger state (`task_view_state`, blocker records, task phase)
2. schedule/runtime signals (`iteration_report`, wakeup context, convergence guard events)
3. persisted outputs (`output_search`, prior tool artifacts)
4. ledger/tape artifacts (`ledger_query`, tape search/info)
5. direct failure output from the most recent attempt

Only fall back to broad new reading/searching when the durable artifacts do not explain the stall.

## What Good Evidence Looks Like

A usable blocker packet usually contains:

- one concrete signal
- one affected scope
- one statement of why forward progress stopped
- one confidence level

Suggested minimum:

```text
BLOCKER_EVIDENCE
- blocker_type: <type>
- signals:
  - "schedule child session hit max consecutive errors"
- affected_scope:
  - "goal-loop: release-verification"
- confidence: high
```

## Source Guidance

### Task ledger

Use first when the loop is task-oriented.

Best for:

- `task_phase` disagreement
- unresolved blockers
- partial completion vs done confusion

### Schedule/runtime signals

Use first when the issue is cadence, continuity, or convergence.

Best for:

- repeated wakeups with no progress
- `scan_convergence_armed`
- `maxRuns` approaching without useful evidence

### Persisted outputs

Use when prior runs produced artifacts that can be reused.

Best for:

- proving whether a fix actually changed output
- comparing last successful vs current failed run
- avoiding repeated low-signal reads

### Direct failure output

Use when a command or execution step failed concretely.

Best for:

- routing to `debugging`
- isolating first failing boundary

## When Evidence Is Still Insufficient

Choose one explicit outcome:

- `WAIT_FOR_INPUT` if the missing fact must come from the user or an external system
- `SWITCH_TO_PLANNING` if the contract itself is under-specified
- stop with low confidence and say exactly which missing artifact would unlock a better decision

Do not compensate for missing evidence with broader speculation.
