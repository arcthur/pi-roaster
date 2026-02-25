import { describe, expect, test } from "bun:test";
import { ParallelBudgetManager } from "@brewva/brewva-runtime";

describe("S-007 parallel budget control", () => {
  test("given configured parallel limits, when acquiring and releasing runs, then maxConcurrent and maxTotal are enforced", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
    });

    expect(manager.acquire("s7", "run-a").accepted).toBe(true);
    const blocked = manager.acquire("s7", "run-b");
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("max_concurrent");

    manager.release("s7", "run-a");
    expect(manager.acquire("s7", "run-b").accepted).toBe(true);
    manager.release("s7", "run-b");
    for (let i = 0; i < 8; i += 1) {
      const runId = `run-extra-${i}`;
      expect(manager.acquire("s7", runId).accepted).toBe(true);
      manager.release("s7", runId);
    }
    const totalBlocked = manager.acquire("s7", "run-c");
    expect(totalBlocked.accepted).toBe(false);
    expect(totalBlocked.reason).toBe("max_total");
  });
});
