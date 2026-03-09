---
name: zca-structured-output
description: Zero-Context Architecture workflow for bounded structured extraction and normalization. Use when a task needs projected input, explicit output contract, deterministic validation, and limited repair without runtime kernel changes.
stability: experimental
effect_level: execute
tools:
  required: [read, exec]
  optional: [grep, ledger_query, task_view_state, skill_complete]
  denied: [edit, write, process]
budget:
  max_tool_calls: 45
  max_tokens: 120000
outputs: [zca_scope, zca_contract, zca_result, zca_validation, zca_repair]
requires: []
consumes: [execution_steps]
composable_with: [planning, verification, recovery]
---

# ZCA Structured Output Pack Skill

## Intent

Reduce large or noisy inputs into a minimal, auditable slice, generate a structured result under
an explicit contract, and converge through deterministic validation plus bounded repair.

This skill is appropriate when you need to:

- extract structured data from noisy text, logs, JSON, or mixed context
- enforce an explicit schema and invariant set rather than a best-effort narrative result
- classify failure modes clearly and cap retries
- keep projection, contract, and repair logic in the agent workflow without changing runtime kernel behavior

## Trigger

Use this skill when:

- the task requires a fixed structured output shape
- the source surface is large enough that full-context reading would reduce correctness
- the task can tolerate limited repair, but not open-ended retry loops
- you need explicit projection exclusions and validation evidence

Do not use this skill when:

- the task is fundamentally about code changes or file mutation
- the primary data source is live DOM interaction or browser state
- a simple one-pass summary is sufficient
- the output is too large to summarize and the environment cannot support temporary artifacts

## Reference Map

Read [references/projection-patterns.md](references/projection-patterns.md)
to choose projection scope, exclusion discipline, and reduction reporting.

Read [references/contract-validation.md](references/contract-validation.md)
to keep the validator path fixed to `bun eval + ajv`, with explicit failure categories and artifact policy.

Read [references/repair-loop-protocol.md](references/repair-loop-protocol.md)
to decide when repair is justified, how to narrow retries, and how to fold the result into `zca_repair`.

## Core Boundary

This skill owns the agent-side workflow only. It does not extend or replace runtime governance.

Responsibility split:

- **runtime owns**: normal tool execution, verification gating, skill lifecycle, and event or ledger persistence
- **zca-structured-output owns**: projection decisions, contract declaration, candidate generation, validator invocation, and bounded repair

If browser collection is required, use `agent-browser` first to produce a stable input artifact, then apply this skill to the extracted text or JSON.

## Structured Output Workflow

### Step 0: Scope Gate (mandatory)

Before reading any source, declare:

- the input domain
- the output schema and invariants
- the repair budget
- the size policy for large payloads

If upstream `execution_steps` exist, treat them as constraints only. They are not a runtime guarantee.

Blocking output:

```text
ZCA_SCOPE
- domain: "<target domain>"
- included:
  - "<planned source>"
- excluded:
  - item: "<known exclusion>"
    reason: "<why excluded>"
- reduction_estimate: "<rough ratio>"
```

```text
ZCA_CONTRACT
- schema_summary:
  - "<field or rule>"
- invariants:
  - "<rule>"
- repair_budget: <N>
- size_policy: "<inline_summary|artifact_ref>"
```

### Step 1: Projection

Read only the smallest slice that can satisfy the current contract.

Allowed projection modes:

- file scope: `read` plus optional `grep`
- JSON subtree: keep only the target node set
- task or ledger state: `task_view_state`, `ledger_query`

Rules:

- record exclusions explicitly instead of saying content was merely "omitted"
- when the source is large, narrow scope before reading more
- v1 does not support DOM subtree projection

### Step 2: Canonicalization

Stabilize the projected input so the output contract is not exposed to avoidable noise.

Preferred normalization actions:

- sort keys
- trim whitespace
- normalize enums, units, currency codes, and casing
- remove obviously irrelevant metadata

If the canonicalized payload is still large:

- keep only a summary in narrative outputs
- use `exec` to generate a temporary artifact if necessary
- retain only `artifact_ref`, hashes, counts, or field summaries in the final result

### Step 3: Execution

Generate one structured candidate from the canonicalized input.

Rules:

- satisfy the contract before optimizing presentation
- do not perform open-ended retry here
- keep validation logic separate from the candidate payload

### Step 4: Validation

Validation must run through `exec` using `bun eval + ajv`.

The validator must cover:

- JSON Schema conformance
- invariants
- parse failures
- timeout and tool-failure conditions

Blocking output:

```text
ZCA_VALIDATION
- verdict: <pass|fail>
- validator: "bun eval + ajv"
- failure_category: <none|schema_mismatch|invariant_violation|parse_error|timeout|tool_failure>
- evidence: "<key output line or artifact summary>"
```

Do not claim validation success without validator evidence.

### Step 5: Repair Or Complete

Enter repair only when all of the following are true:

- the validator returned a concrete failure category
- the diagnosis is specific enough to localize the issue
- repair budget remains

Each repair attempt must narrow scope relative to the prior attempt:

- repair only failing fields
- retry only the failing section
- stop after the same structural failure repeats twice

Always finish by calling `skill_complete` with all required outputs:

```json
{
  "zca_scope": {
    "domain": "pricing extraction",
    "included": ["api.json:data.pricing"],
    "excluded": ["metadata", "pagination"],
    "reduction_estimate": "about 80%"
  },
  "zca_contract": {
    "schema_summary": ["plans[].name:string", "plans[].price:number"],
    "invariants": ["price > 0"],
    "repair_budget": 2,
    "size_policy": "inline_summary"
  },
  "zca_result": {
    "status": "validated",
    "data_summary": "3 plans extracted",
    "artifact_ref": null
  },
  "zca_validation": {
    "verdict": "pass",
    "validator": "bun eval + ajv",
    "failure_category": "none",
    "evidence": "VALID"
  },
  "zca_repair": {
    "total_attempts": 0,
    "outcome": "not_needed",
    "last_diagnostic": "validation passed on first attempt"
  }
}
```

Status meanings:

- `validated`: passed on the first validation attempt
- `repaired`: passed after one or more repair attempts
- `exhausted`: repair budget ended without satisfying the contract
- `blocked`: validator unavailable, repeated structural failure, or irreducible source scope

## Stop Conditions

- the contract is validated
- the repair budget is exhausted
- the same structural failure repeats twice
- projection can no longer be narrowed while the input remains uncontrolled
- the validator toolchain is unavailable

When stopping, fold the reason into `zca_validation` and `zca_repair`. Do not rely on narrative-only explanation.

## Escalation

- hand off to `recovery` when repair is exhausted, validator execution is unavailable, or failures repeat structurally
- hand off to `verification` when a validated artifact exists but broader task-level proof is still needed
- hand off to `planning` when the contract itself is unclear or the source boundary is unstable
- hand off to `agent-browser` when page interaction is required to obtain a stable source artifact

## Anti-Patterns

- claiming projection discipline without recording exclusions
- claiming schema satisfaction without validator evidence
- placing large raw payloads directly into `skill_complete` outputs
- repeating the same repair attempt without narrowing scope
- pretending v1 supports DOM subtree projection
- using `truth_upsert`, custom runtime hooks, or nonexistent kernel APIs

## Example

A representative use case is extracting only `data.pricing` from a large API response, normalizing
currency and price fields, and validating the result with `bun eval + ajv`. See the worked example in
[templates/extract-api-response.md](templates/extract-api-response.md).

## Templates

- [templates/extract-api-response.md](templates/extract-api-response.md)

