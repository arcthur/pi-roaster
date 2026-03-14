# Budget Matrix

This document summarizes Brewva budget pipelines, their units, enforcement boundaries,
and replay/observability sources.

## Runtime Budget Pipelines

| Pipeline                    | Unit                  | Enforcement Point                                                          | Events                                                                                                                                  | Config Key                                                      | Recovery Source                            |
| --------------------------- | --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| **Session Cost**            | USD                   | `ToolGateService.checkToolAccess` via `SessionCostTracker.getBudgetStatus` | `tool_call_marked`, `cost_update`, `budget_alert`                                                                                       | `infrastructure.costTracking.*`                                 | checkpoint `state.cost` + shared cost fold |
| **Context Injection**       | tokens                | `ContextBudgetManager.planInjection`                                       | `context_injected`, `context_injection_dropped`                                                                                         | `infrastructure.contextBudget.*`                                | runtime-local state only                   |
| **Context Compaction Gate** | context window ratio  | `ContextPressureService.checkContextCompactionGate`                        | `context_compaction_requested`, `context_compaction_gate_blocked_tool`, `context_compacted`                                             | `infrastructure.contextBudget.compaction.*`, `hardLimitPercent` | runtime-local state only                   |
| **Context Arena SLO**       | entry count           | `ContextArena.ensureAppendCapacity`                                        | `context_arena_slo_enforced`                                                                                                            | `infrastructure.contextBudget.arena.maxEntriesPerSession`       | rebuilt from tape events                   |
| **Governance Checks**       | checks / turn         | effect authorization plus verification/cost/compaction governance hooks    | `proposal_*`, `decision_receipt_recorded`, `governance_verify_spec_*`, `governance_cost_anomaly_*`, `governance_compaction_integrity_*` | `BrewvaRuntimeOptions.governancePort`                           | tape events + checkpoint replay            |
| **Parallel**                | concurrent/total runs | `ParallelBudgetManager.acquire`                                            | operational acquire/release telemetry                                                                                                   | `parallel.*` + internal `PARALLEL_MAX_TOTAL_PER_SESSION`        | runtime-local slot state only              |

## Skill Contract Budgets (Orthogonal)

Skill contract budgets are enforced at tool gate and are separate from session USD budget:

| Budget         | Unit                                                               | Modes                                                                       | Event Signals                               |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------- |
| `maxTokens`    | tracked tokens (`input + output + cacheWrite`, excludes cacheRead) | `off \| warn \| enforce` (via `security.enforcement.skillMaxTokensMode`)    | `skill_budget_warning`, `tool_call_blocked` |
| `maxToolCalls` | tool call count                                                    | `off \| warn \| enforce` (via `security.enforcement.skillMaxToolCallsMode`) | `skill_budget_warning`, `tool_call_blocked` |

## `costTracking.enabled` Semantics

When `infrastructure.costTracking.enabled=false`:

- usage accounting is still recorded (`totalTokens`, `totalCostUsd`, model/skill/tool breakdown)
- budget blocking is disabled (`budget.blocked=false`, `budget.sessionExceeded=false`)
- budget alerts are suppressed (`alerts=[]`)

When `enabled=true`, session budget behavior is controlled by:

- `maxCostUsdPerSession`
- `alertThresholdRatio`
- `actionOnExceed` (`warn` or `block_tools`)

## Governance Check Semantics

Governance checks are optional adapters, but once configured they participate in the
runtime decision loop:

- `authorizeEffectCommitment` decides whether commitment-posture tool effects
  may execute or must stay deferred.
- `verifySpec` can convert a verification pass into a governance failure with blocker evidence.
- `detectCostAnomaly` emits anomaly diagnostics without changing session accounting totals.
- `checkCompactionIntegrity` validates compaction summaries and emits governance integrity events.
