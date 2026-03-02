# Oracle Consultation Protocol

Use this protocol when deep external reasoning is needed for architecture, debugging, or review decisions.

## When to Consult

Consult when any applies:

1. Multi-file or cross-module behavior.
2. Root cause remains unclear after focused investigation.
3. Multiple viable options with non-obvious trade-offs.
4. Potential API, persistence, migration, security, or concurrency impact.
5. Verification fails and the next move is uncertain.

Skip for clear, local, low-risk edits.

## Required Input Packet

Always provide:

```text
ORACLE_BRIEF
- objective: "<target outcome>"
- current_state: "<what exists now>"
- evidence:
  - "<error/log/test signal>"
- attempted_actions:
  - "<what has been tried>"
- constraints:
  - "<hard constraints>"
- decision_needed: "<specific question>"
- candidate_files:
  - "<path>"
```

## Normalization Contract

Do not execute directly from raw advice. Normalize first:

```text
ORACLE_SYNTHESIS
- top_findings:
  - "<finding>"
- decisions:
  - "<decision>"
- rejected_options:
  - "<option + reason>"
- implementation_steps:
  - "<step>"
- verification_focus:
  - "<what to test/check>"
```

## Multi-Round Limit

- Maximum 3 consultation rounds per task.
- If still unresolved after round 3, stop and request missing external context.

## Guardrails

- Avoid vague prompts.
- Narrow to hot-path files; avoid dumping large unrelated file sets.
- Treat advice as advisory; local constraints and verification remain authoritative.
