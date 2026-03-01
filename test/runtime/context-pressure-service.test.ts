import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { ContextBudgetManager } from "../../packages/brewva-runtime/src/context/budget.js";
import { ContextPressureService } from "../../packages/brewva-runtime/src/services/context-pressure.js";
import type {
  BrewvaEventRecord,
  ContextBudgetUsage,
} from "../../packages/brewva-runtime/src/types.js";

function createUsage(percent: number): ContextBudgetUsage {
  return {
    tokens: Math.round(percent * 1_000),
    contextWindow: 1_000,
    percent,
  };
}

describe("ContextPressureService", () => {
  test("blocks tools on critical pressure and emits expected payload", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.hardLimitPercent = 0.8;
    config.infrastructure.contextBudget.compactionThresholdPercent = 0.7;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("pressure-session", 12);

    const service = new ContextPressureService({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 12,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const usage = createUsage(0.9);
    service.observeContextUsage("pressure-session", usage);

    const gate = service.getContextCompactionGateStatus("pressure-session", usage);
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("hard_limit");

    const gateDecision = service.checkContextCompactionGate("pressure-session", "exec", usage);
    expect(gateDecision.allowed).toBe(false);

    const blocked = events.find((event) => event.type === "context_compaction_gate_blocked_tool");
    expect(blocked).toBeDefined();
    expect(blocked?.payload).toEqual(
      expect.objectContaining({
        blockedTool: "exec",
        reason: "critical_context_pressure_without_compaction",
        usagePercent: 0.9,
        hardLimitPercent: 0.8,
      }),
    );
  });

  test("keeps floor_unmet gate active and deduplicates compaction request events", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const budget = new ContextBudgetManager(config.infrastructure.contextBudget);
    budget.beginTurn("floor-session", 7);

    const service = new ContextPressureService({
      config,
      contextBudget: budget,
      getCurrentTurn: () => 7,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const lowUsage = createUsage(0.2);
    service.requestCompaction("floor-session", "floor_unmet", lowUsage);
    service.requestCompaction("floor-session", "floor_unmet", lowUsage);

    const requestedEvents = events.filter((event) => event.type === "context_compaction_requested");
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]?.payload).toEqual(
      expect.objectContaining({
        reason: "floor_unmet",
        usagePercent: 0.2,
        tokens: 200,
      }),
    );

    const gate = service.getContextCompactionGateStatus("floor-session", lowUsage);
    expect(gate.required).toBe(true);
    expect(gate.reason).toBe("floor_unmet");
  });
});
