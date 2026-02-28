import { describe, expect, test } from "bun:test";
import { ContextStabilityMonitor } from "@brewva/brewva-runtime";

describe("ContextStabilityMonitor", () => {
  const sessionId = "context-stability-monitor-session";

  test("starts in normal state", () => {
    const monitor = new ContextStabilityMonitor({ consecutiveThreshold: 2 });
    expect(monitor.isStabilized(sessionId)).toBe(false);
    expect(monitor.snapshot(sessionId)).toEqual({
      consecutiveDegradedTurns: 0,
      stabilized: false,
      stabilizedTurns: 0,
    });
  });

  test("trips after threshold and uses periodic probe turns", () => {
    const monitor = new ContextStabilityMonitor({
      consecutiveThreshold: 2,
      recoveryProbeIntervalTurns: 3,
    });

    expect(monitor.recordDegraded(sessionId, 1)).toBe(false);
    expect(monitor.recordDegraded(sessionId, 2)).toBe(true);
    expect(monitor.isStabilized(sessionId)).toBe(true);

    expect(monitor.shouldForceCriticalOnly(sessionId, 1)).toBe(true);
    expect(monitor.shouldForceCriticalOnly(sessionId, 1)).toBe(true);
    expect(monitor.shouldForceCriticalOnly(sessionId, 2)).toBe(true);
    expect(monitor.shouldForceCriticalOnly(sessionId, 3)).toBe(false);
    expect(monitor.shouldForceCriticalOnly(sessionId, 4)).toBe(true);
  });

  test("counts degraded outcomes by turn, not by repeated calls", () => {
    const monitor = new ContextStabilityMonitor({ consecutiveThreshold: 2 });

    expect(monitor.recordDegraded(sessionId, 1)).toBe(false);
    expect(monitor.recordDegraded(sessionId, 1)).toBe(false);
    expect(monitor.isStabilized(sessionId)).toBe(false);

    expect(monitor.recordDegraded(sessionId, 2)).toBe(true);
    expect(monitor.isStabilized(sessionId)).toBe(true);
  });

  test("forced successful turns do not reset stabilized state", () => {
    const monitor = new ContextStabilityMonitor({ consecutiveThreshold: 1 });
    monitor.recordDegraded(sessionId, 1);
    expect(monitor.isStabilized(sessionId)).toBe(true);

    expect(monitor.recordNormal(sessionId, { wasForced: true, turn: 2 })).toBe(false);
    expect(monitor.isStabilized(sessionId)).toBe(true);
  });

  test("unforced successful turn resets stabilized state", () => {
    const monitor = new ContextStabilityMonitor({ consecutiveThreshold: 1 });
    monitor.recordDegraded(sessionId, 1);
    expect(monitor.isStabilized(sessionId)).toBe(true);

    expect(monitor.recordNormal(sessionId, { wasForced: false, turn: 2 })).toBe(true);
    expect(monitor.isStabilized(sessionId)).toBe(false);
  });

  test("degraded outcome during stabilized mode restarts probe cadence", () => {
    const monitor = new ContextStabilityMonitor({
      consecutiveThreshold: 1,
      recoveryProbeIntervalTurns: 2,
    });
    monitor.recordDegraded(sessionId, 1);
    expect(monitor.shouldForceCriticalOnly(sessionId, 1)).toBe(true);
    expect(monitor.shouldForceCriticalOnly(sessionId, 2)).toBe(false);

    monitor.recordDegraded(sessionId, 3);
    expect(monitor.shouldForceCriticalOnly(sessionId, 3)).toBe(true);
  });

  test("clearSession drops session state", () => {
    const monitor = new ContextStabilityMonitor({ consecutiveThreshold: 1 });
    monitor.recordDegraded(sessionId);
    expect(monitor.isStabilized(sessionId)).toBe(true);

    monitor.clearSession(sessionId);
    expect(monitor.isStabilized(sessionId)).toBe(false);
    expect(monitor.snapshot(sessionId)).toEqual({
      consecutiveDegradedTurns: 0,
      stabilized: false,
      stabilizedTurns: 0,
    });
  });

  test("disabled monitor never trips", () => {
    const monitor = new ContextStabilityMonitor({ consecutiveThreshold: 0 });
    monitor.recordDegraded(sessionId);
    monitor.recordDegraded(sessionId);
    expect(monitor.isStabilized(sessionId)).toBe(false);
    expect(monitor.shouldForceCriticalOnly(sessionId, 1)).toBe(false);
  });
});
