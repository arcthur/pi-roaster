import { describe, expect, test } from "bun:test";
import { ZoneBudgetController, type ZoneBudgetConfig } from "@brewva/brewva-runtime";

const BASE_CONFIG: ZoneBudgetConfig = {
  identity: { min: 0, max: 320 },
  truth: { min: 0, max: 420 },
  task_state: { min: 0, max: 360 },
  tool_failures: { min: 0, max: 480 },
  memory_working: { min: 0, max: 300 },
  memory_recall: { min: 0, max: 600 },
  rag_external: { min: 0, max: 160 },
};

describe("ZoneBudgetController", () => {
  test("adapts zone max budgets after sustained truncation and idle pressure", () => {
    const controller = new ZoneBudgetController(BASE_CONFIG, {
      enabled: true,
      emaAlpha: 1,
      minTurnsBeforeAdapt: 3,
      stepTokens: 32,
      maxShiftPerTurn: 96,
      upshiftTruncationRatio: 0.2,
      downshiftIdleRatio: 0.2,
    });

    const telemetry = {
      zoneDemandTokens: {
        identity: 0,
        truth: 300,
        task_state: 0,
        tool_failures: 0,
        memory_working: 0,
        memory_recall: 0,
        rag_external: 120,
      },
      zoneAllocatedTokens: {
        identity: 0,
        truth: 300,
        task_state: 0,
        tool_failures: 0,
        memory_working: 0,
        memory_recall: 0,
        rag_external: 120,
      },
      zoneAcceptedTokens: {
        identity: 0,
        truth: 60,
        task_state: 0,
        tool_failures: 0,
        memory_working: 0,
        memory_recall: 0,
        rag_external: 0,
      },
    };

    expect(controller.observe("s1", telemetry)).toBeNull();
    expect(controller.observe("s1", telemetry)).toBeNull();
    const adjustment = controller.observe("s1", telemetry);
    expect(adjustment).not.toBeNull();
    if (!adjustment) {
      throw new Error("expected zone budget adjustment");
    }

    expect(adjustment.changed).toBe(true);
    expect(adjustment.movedTokens).toBeGreaterThan(0);
    expect(adjustment.maxByZone.truth).toBeGreaterThan(BASE_CONFIG.truth.max);
    expect(adjustment.maxByZone.rag_external).toBeLessThan(BASE_CONFIG.rag_external.max);

    const resolved = controller.resolveZoneBudgetConfig("s1");
    expect(resolved.truth.max).toBe(adjustment.maxByZone.truth);
    expect(resolved.rag_external.max).toBe(adjustment.maxByZone.rag_external);
  });
});
