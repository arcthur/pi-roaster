# Plan Output Template

## Plan Packet

```text
OBJECTIVE
- statement: "<what success means>"

ASSUMPTIONS
- "<assumption>"
- "<assumption>"

CONSTRAINTS
- hard:
  - "<constraint>"
- soft:
  - "<preference>"

OPTIONS
OPTION_A
- summary: "<approach>"
- impact_scope:
  - "<module/path>"
- pros:
  - "<point>"
- cons:
  - "<point>"
- risks:
  - "<risk>"
- validation:
  - "<check>"

OPTION_B
...

PLAN_DECISION
- selected_option: <A|B|C>
- rationale: "<why>"

EXECUTION_STEPS
1. "<step>" -> verify: "<check>"
2. "<step>" -> verify: "<check>"

RISK_REGISTER
- risk: "<risk>"
  likelihood: <low|medium|high>
  impact: <low|medium|high>
  mitigation: "<mitigation>"
  fallback: "<fallback>"

VERIFICATION_PLAN
- targeted:
  - "<check>"
- broader:
  - "<check>"
- acceptance_criteria:
  - "<criterion>"
```

## Review Rules
- Every step must have a verification check.
- Every medium/high risk must have fallback.
- If option difference is trivial, merge and keep one option.
