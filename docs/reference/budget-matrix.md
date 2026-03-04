# Budget Matrix

This document summarizes Brewva budget pipelines, their units, enforcement boundaries,
and replay/observability sources.

## Runtime Budget Pipelines

| Pipeline                    | Unit                  | Enforcement Point                                                          | Events                                                                                      | Config Key                                                      | Recovery Source                                |
| --------------------------- | --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| **Session Cost**            | USD                   | `ToolGateService.checkToolAccess` via `SessionCostTracker.getBudgetStatus` | `cost_update`, `budget_alert`                                                               | `infrastructure.costTracking.*`                                 | checkpoint `state.cost` + `cost_update` replay |
| **Context Injection**       | tokens                | `ContextBudgetManager.planInjection`                                       | `context_injected`, `context_injection_dropped`                                             | `infrastructure.contextBudget.*`                                | `ContextBudgetSessionState` snapshot           |
| **Context Compaction Gate** | context window ratio  | `ContextPressureService.checkContextCompactionGate`                        | `context_compaction_requested`, `context_compaction_gate_blocked_tool`, `context_compacted` | `infrastructure.contextBudget.compaction.*`, `hardLimitPercent` | `ContextBudgetSessionState` snapshot           |
| **Context Arena SLO**       | entry count           | `ContextArena.ensureAppendCapacity`                                        | `context_arena_slo_enforced`                                                                | `infrastructure.contextBudget.arena.maxEntriesPerSession`       | rebuilt from tape events                       |
| **Parallel**                | concurrent/total runs | `ParallelBudgetManager.acquire`                                            | operational acquire/release telemetry                                                       | `parallel.*` + internal `PARALLEL_MAX_TOTAL_PER_SESSION`        | `ParallelSessionSnapshot`                      |

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

## Cognitive Budget

Cognitive calls are bounded by `memory.cognitive.maxTokensPerTurn` and tracked by
`SessionCostTracker.getCognitiveBudgetStatus(...)`. Exhaustion causes deterministic
fallback for cognitive-dependent paths.
