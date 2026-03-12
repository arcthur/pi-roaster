---
intent:
  outputs:
    - review_report
    - review_findings
    - merge_decision
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - lsp_diagnostics
    - lsp_symbols
    - lsp_find_references
    - ast_grep_search
    - ledger_query
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/migration-priority-matrix.md
scripts:
  - skills/project/scripts/check-skill-dod.sh
consumes:
  - change_set
  - design_spec
  - verification_evidence
  - impact_map
---

# Brewva Review Overlay

## Intent

Review Brewva changes against project invariants, not just generic code quality.

## Trigger

Use this overlay when reviewing changes in the Brewva monorepo.

## Workflow

### Step 1: Check invariant-sensitive surfaces

Prioritize runtime governance, package boundaries, CLI branding, config shape, and dist safety.

### Step 2: Call out project-specific regressions

Surface violations of the migration matrix, skill DoD, or artifact contract clarity.

## Stop Conditions

- there is no concrete diff or artifact to review
- the review target is missing the evidence needed for Brewva-specific judgment

## Anti-Patterns

- reviewing only code style while missing kernel boundary drift
- ignoring docs and exported surface changes in catalog refactors

## Example

Input: "Review whether the v2 taxonomy change leaked internal phases back into the public catalog."
