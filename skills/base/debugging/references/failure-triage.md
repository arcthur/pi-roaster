# Failure Triage Reference

## Failure Categories

| Category | Typical Signal | First Probe |
| --- | --- | --- |
| Compile/Type | compiler diagnostics | inspect first error and signature mismatch |
| Unit test | assertion mismatch | inspect fixture/setup and expected output |
| Integration | cross-module mismatch | inspect boundary contracts and environment setup |
| Runtime | exception/timeout | inspect call path and input/state assumptions |

## Fast Prioritization
1. Prefer deterministic failures over intermittent noise.
2. Prefer first failing check over downstream cascades.
3. Prefer root-cause boundary over symptom line.

## Triage Prompts
Use these prompts when debugging stalls:
- Which input contract is violated at the first failing boundary?
- Is there a recent change in type/schema/config expected by this path?
- Does failing path differ from passing path in one critical branch?

## Evidence Quality
High-quality evidence includes:
- exact command used
- exact first failing line
- exact file/symbol touched by fix
- before/after verification output
