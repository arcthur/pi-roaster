import { describe, expect, test } from "bun:test";
import { ZoneBudgetAllocator } from "@brewva/brewva-runtime";

const ZONES_CONFIG = {
  identity: { min: 100, max: 320 },
  truth: { min: 80, max: 420 },
  task_state: { min: 60, max: 360 },
  tool_failures: { min: 0, max: 240 },
  memory_working: { min: 50, max: 300 },
  memory_recall: { min: 0, max: 600 },
  rag_external: { min: 0, max: 0 },
} as const;

describe("ZoneBudgetAllocator", () => {
  test("allocates within budget when floors are satisfiable", () => {
    const allocator = new ZoneBudgetAllocator(ZONES_CONFIG);
    const result = allocator.allocate({
      totalBudget: 1200,
      zoneDemands: {
        identity: 200,
        truth: 150,
        task_state: 100,
        tool_failures: 80,
        memory_working: 120,
        memory_recall: 300,
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.identity).toBeGreaterThanOrEqual(100);
    expect(result.truth).toBeGreaterThanOrEqual(80);
  });

  test("rejects when demanded floor sum exceeds total budget", () => {
    const allocator = new ZoneBudgetAllocator({
      identity: { min: 400, max: 500 },
      truth: { min: 400, max: 500 },
      task_state: { min: 400, max: 500 },
      tool_failures: { min: 0, max: 100 },
      memory_working: { min: 0, max: 100 },
      memory_recall: { min: 0, max: 100 },
      rag_external: { min: 0, max: 0 },
    });
    const result = allocator.allocate({
      totalBudget: 500,
      zoneDemands: {
        identity: 400,
        truth: 400,
        task_state: 400,
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("floor_unmet");
  });

  test("when budget is tight, low-priority recall gets truncated first", () => {
    const allocator = new ZoneBudgetAllocator(ZONES_CONFIG);
    const result = allocator.allocate({
      totalBudget: 400,
      zoneDemands: {
        identity: 200,
        truth: 150,
        task_state: 100,
        memory_recall: 500,
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.memory_recall).toBeLessThan(500);
    expect(result.identity).toBeGreaterThanOrEqual(100);
  });

  test("zones with zero demand stay zero", () => {
    const allocator = new ZoneBudgetAllocator(ZONES_CONFIG);
    const result = allocator.allocate({
      totalBudget: 1200,
      zoneDemands: {
        identity: 200,
        truth: 100,
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.task_state).toBe(0);
    expect(result.memory_recall).toBe(0);
  });
});
