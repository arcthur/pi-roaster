---
name: skill-authoring
description: Design or revise a skill contract, instructions, and artifacts so the
  catalog stays coherent and composable.
stability: stable
intent:
  outputs:
    - skill_spec
    - skill_contract
    - skill_scaffold
  output_contracts:
    skill_spec:
      kind: text
      min_words: 3
      min_length: 18
    skill_contract:
      kind: text
      min_words: 3
      min_length: 18
    skill_scaffold:
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
    - grep
  fallback_tools:
    - exec
    - glob
    - ledger_query
    - skill_complete
references:
  - references/output-patterns.md
  - references/workflows.md
scripts:
  - scripts/init_skill.py
  - scripts/fork_skill.py
  - scripts/package_skill.py
  - scripts/quick_validate.py
consumes:
  - repository_snapshot
  - design_spec
requires: []
---

# Skill Authoring Skill

## Intent

Create or revise skills so they have clear semantic territory, stable artifacts, and the right routing posture.

## Trigger

Use this skill when:

- adding a new skill to the catalog
- redesigning an existing skill boundary
- tightening a skill contract or artifact schema

## Workflow

### Step 1: Define territory

State the semantic boundary, trigger, and what should stay out of scope.

### Step 2: Shape the contract

Produce:

- `skill_spec`: purpose, trigger, and boundaries
- `skill_contract`: intent, effect governance, explicit `default_lease` plus
  `hard_ceiling`, and execution hints
- `skill_scaffold`: a minimal SKILL skeleton and required resources

### Step 3: Use the current scaffolding tools when structure matters

Use:

- `scripts/init_skill.py` to scaffold a skill under the right category
- `scripts/fork_skill.py` to fork an existing skill into `project/overlays/<name>`
- `scripts/quick_validate.py` before packaging
- `scripts/package_skill.py` when a distributable bundle is needed

## Stop Conditions

- the new skill is really a runtime phase or policy, not a capability
- the skill duplicates existing semantic territory
- there is no stable artifact contract to justify a new skill

## Anti-Patterns

- encoding lifecycle steps as public skills
- creating a new skill when a mode or overlay would suffice
- writing prompts with no durable artifact semantics

## Example

Input: "Design an overlay-aware runtime-forensics skill contract for Brewva."

Output: `skill_spec`, `skill_contract`, `skill_scaffold`.
