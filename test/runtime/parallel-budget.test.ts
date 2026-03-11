import { describe, expect, test } from "bun:test";
import { ParallelBudgetManager } from "@brewva/brewva-runtime";

describe("S-007 parallel budget control", () => {
  test("given configured parallel limits, when acquiring and releasing runs, then maxConcurrent and maxTotal are enforced", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
      maxTotalPerSession: 10,
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

  test("given custom maxTotalPerSession, when limit is reached, then max_total is returned", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 5,
      maxTotalPerSession: 3,
    });

    for (let i = 0; i < 3; i += 1) {
      const result = manager.acquire("s7b", `run-${i}`);
      expect(result.accepted).toBe(true);
      manager.release("s7b", `run-${i}`);
    }
    const blocked = manager.acquire("s7b", "run-over");
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("max_total");
  });

  test("given maxConcurrent is saturated, when acquireAsync waits and a slot is released, then the waiter is resumed", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
      maxTotalPerSession: 10,
    });

    expect(manager.acquire("s7c", "run-a").accepted).toBe(true);
    const waiting = manager.acquireAsync("s7c", "run-b");

    manager.release("s7c", "run-a");
    const acquired = await waiting;
    expect(acquired).toEqual({ accepted: true });
    manager.release("s7c", "run-b");
  });

  test("given queued waiters exist, when the session is cleared, then acquireAsync is cancelled", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
      maxTotalPerSession: 10,
    });

    expect(manager.acquire("s7d", "run-a").accepted).toBe(true);
    const waiting = manager.acquireAsync("s7d", "run-b");

    manager.clear("s7d");
    expect(await waiting).toEqual({ accepted: false, reason: "cancelled" });
  });

  test("given waiters time out, when no slot opens before the deadline, then acquireAsync resolves timeout", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
      maxTotalPerSession: 10,
    });

    expect(manager.acquire("s7e", "run-a").accepted).toBe(true);
    expect(await manager.acquireAsync("s7e", "run-b", { timeoutMs: 5 })).toEqual({
      accepted: false,
      reason: "timeout",
    });
  });

  test("given duplicate waiters for the same runId, when capacity opens, then only one waiter acquires the slot", async () => {
    const manager = new ParallelBudgetManager({
      enabled: true,
      maxConcurrent: 1,
      maxTotalPerSession: 10,
    });

    expect(manager.acquire("s7f", "run-a").accepted).toBe(true);
    const firstWaiting = manager.acquireAsync("s7f", "run-b");
    const duplicateWaiting = manager.acquireAsync("s7f", "run-b");

    expect(await duplicateWaiting).toEqual({ accepted: false, reason: "max_concurrent" });

    manager.release("s7f", "run-a");
    expect(await firstWaiting).toEqual({ accepted: true });
  });
});
