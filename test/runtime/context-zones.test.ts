import { describe, expect, test } from "bun:test";
import { ZONE_ORDER, zoneForSource } from "@brewva/brewva-runtime";

describe("context zones", () => {
  test("maps known sources to deterministic zones", () => {
    expect(zoneForSource("brewva.identity")).toBe("identity");
    expect(zoneForSource("brewva.truth-static")).toBe("truth");
    expect(zoneForSource("brewva.truth-facts")).toBe("truth");
    expect(zoneForSource("brewva.task-state")).toBe("task_state");
    expect(zoneForSource("brewva.tool-failures")).toBe("tool_failures");
    expect(zoneForSource("brewva.memory-working")).toBe("memory_working");
    expect(zoneForSource("brewva.memory-recall")).toBe("memory_recall");
    expect(zoneForSource("brewva.rag-external")).toBe("rag_external");
  });

  test("falls back unknown sources to memory_recall zone", () => {
    expect(zoneForSource("unknown.source")).toBe("memory_recall");
  });

  test("keeps truth and task_state adjacent in zone order", () => {
    const truthIndex = ZONE_ORDER.indexOf("truth");
    const taskIndex = ZONE_ORDER.indexOf("task_state");
    expect(Math.abs(truthIndex - taskIndex)).toBe(1);
    expect(ZONE_ORDER[0]).toBe("identity");
  });

  test("places rag_external after memory_recall", () => {
    const recallIndex = ZONE_ORDER.indexOf("memory_recall");
    const ragIndex = ZONE_ORDER.indexOf("rag_external");
    expect(recallIndex).toBeGreaterThanOrEqual(0);
    expect(ragIndex).toBe(recallIndex + 1);
  });
});
