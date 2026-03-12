---
name: structured-extraction
description: Convert noisy text or semi-structured input into validated structured
  output with repair-minded discipline.
stability: stable
intent:
  outputs:
    - structured_payload
    - extraction_report
  output_contracts:
    structured_payload:
      kind: json
      min_keys: 1
      min_items: 1
    extraction_report:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
    - exec
  fallback_tools:
    - grep
    - skill_complete
references:
  - references/contract-validation.md
  - references/projection-patterns.md
  - references/repair-loop-protocol.md
  - templates/extract-api-response.md
consumes:
  - browser_observations
requires: []
---

# Structured Extraction Skill

## Intent

Turn messy input into durable structured data and make the repair logic explicit.

## Trigger

Use this skill when:

- free-form text must be normalized into a schema
- extraction quality matters more than raw summarization
- downstream systems need stable keys instead of prose

## Workflow

### Step 1: Define the target shape

Name the schema, required fields, and repair rules.

### Step 2: Extract and validate

Normalize the input, repair obvious shape issues, and flag unresolved ambiguity.

### Step 3: Emit extraction artifacts

Produce:

- `structured_payload`: the structured result
- `extraction_report`: confidence, repairs, and unresolved gaps

## Stop Conditions

- no stable schema can be defined from the request
- source ambiguity is too high to repair safely
- the task is ordinary summarization rather than structured extraction

## Anti-Patterns

- returning prose when a schema was requested
- silently inventing fields to satisfy shape requirements
- mixing extraction with downstream business decisions

## Example

Input: "Extract a stable issue triage record from this noisy incident thread."

Output: `structured_payload`, `extraction_report`.
