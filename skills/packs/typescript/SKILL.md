---
name: typescript
description: TypeScript-specific standards for typing, narrowing, and boundary contracts.
version: 1.0.0
stability: stable
tier: pack
tags: [typescript, ts, types, narrowing]
anti_tags: [python, rust]
tools:
  required: [read]
  optional: [lsp_diagnostics, ast_grep_search, skill_complete]
  denied: []
budget:
  max_tool_calls: 45
  max_tokens: 100000
outputs: [type_boundary_changes, diagnostics_status]
consumes: [change_summary]
escalation_path:
  external_contract_unknown: exploration
---

# TypeScript Pack Skill

## Intent
Apply TypeScript changes with strict boundary typing and predictable diagnostics behavior.

## Trigger
Use this pack when editing `.ts` / `.tsx` code or TypeScript contracts.

## Core Rules
- Prefer explicit types at module boundaries (inputs/outputs/public APIs).
- Avoid `any`; use `unknown` + narrowing when dynamic data is required.
- Keep inference for local expressions only, not external contracts.
- Maintain runtime-safe guards for untrusted data.

## Workflow

### Step 1: Identify boundary surfaces
Locate changed boundaries:
- exported functions/classes/types
- DTOs, config types, tool interfaces
- parser/serializer entrypoints

### Step 2: Apply type-safe edits
Preferred patterns:
- discriminated unions for variant states
- `satisfies` for object literal contract validation
- narrow unknowns using dedicated type guards
- exhaustiveness checks for union switches

Avoid:
- broad casting (`as any`, `as unknown as T`) without proof
- optional chaining that hides required invariants
- widening literal types unnecessarily

### Step 3: Preserve compatibility
When changing type signatures:
- verify all call sites
- keep backward-compatible overload if migration is required
- avoid silent breaking changes in shared interfaces

### Step 4: Verify diagnostics
Recommended checks:
```bash
bun run typecheck
```

If typecheck is unavailable, run configured diagnostics tool and report limitation.

## Review Checklist
- Are boundary types explicit and precise?
- Are null/undefined states handled intentionally?
- Are casts justified and minimal?
- Is async error typing handled consistently?

## Stop Conditions
- Required type boundary decisions are blocked by unknown external contracts.
- Typecheck cannot run and diagnostics output is unavailable.
- Fix requires broad public API changes outside requested scope.

## Anti-Patterns (never)
- Replacing strict types with `any` to silence errors.
- Adding non-null assertions (`!`) without invariant proof.
- Hiding missing union branches with default fallthrough.
- Mixing type refactor with unrelated logic changes.

## Example

Input:
```text
"Fix type mismatch in verification evidence classification."
```

Expected output:
1. boundary type update in relevant interface.
2. local narrowing where dynamic data enters.
3. diagnostics status with clear pass/fail evidence.
