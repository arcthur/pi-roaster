import { describe, expect, test } from "bun:test";
import { ContextBudgetManager, DEFAULT_ROASTER_CONFIG } from "@pi-roaster/roaster-runtime";

describe("Context budget manager", () => {
  test("uses conservative token estimate for injection decisions", () => {
    const manager = new ContextBudgetManager({
      ...DEFAULT_ROASTER_CONFIG.infrastructure.contextBudget,
    });

    const decision = manager.planInjection("budget-conservative-1", "x".repeat(15), {
      tokens: 500,
      contextWindow: 2000,
      percent: 0.25,
    });

    expect(decision.accepted).toBe(true);
    expect(decision.originalTokens).toBe(5);
    expect(decision.finalTokens).toBe(5);
  });

  test("applies conservative truncation at token boundary", () => {
    const manager = new ContextBudgetManager({
      ...DEFAULT_ROASTER_CONFIG.infrastructure.contextBudget,
      maxInjectionTokens: 32,
    });

    const decision = manager.planInjection("budget-conservative-2", "x".repeat(200));
    expect(decision.accepted).toBe(true);
    expect(decision.finalText.length).toBe(112);
    expect(decision.finalTokens).toBe(32);
  });

  test("applies wall-clock cooldown between compactions", () => {
    let nowMs = 1_000;
    const manager = new ContextBudgetManager(
      {
        ...DEFAULT_ROASTER_CONFIG.infrastructure.contextBudget,
        minTurnsBetweenCompaction: 0,
        minSecondsBetweenCompaction: 45,
        pressureBypassPercent: 0.95,
      },
      {
        now: () => nowMs,
      },
    );
    const sessionId = "budget-cooldown-time";

    manager.beginTurn(sessionId, 1);
    const first = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_650,
      contextWindow: 2_000,
      percent: 0.825,
    });
    expect(first.shouldCompact).toBe(true);
    expect(first.reason).toBe("usage_threshold");
    manager.markCompacted(sessionId);

    manager.beginTurn(sessionId, 2);
    nowMs += 10_000;
    const second = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_660,
      contextWindow: 2_000,
      percent: 0.83,
    });
    expect(second.shouldCompact).toBe(false);

    manager.beginTurn(sessionId, 3);
    nowMs += 36_000;
    const third = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_680,
      contextWindow: 2_000,
      percent: 0.84,
    });
    expect(third.shouldCompact).toBe(true);
    expect(third.reason).toBe("usage_threshold");
  });

  test("bypasses cooldown under high pressure and hard limit", () => {
    let nowMs = 5_000;
    const manager = new ContextBudgetManager(
      {
        ...DEFAULT_ROASTER_CONFIG.infrastructure.contextBudget,
        minTurnsBetweenCompaction: 10,
        minSecondsBetweenCompaction: 300,
        pressureBypassPercent: 0.9,
      },
      {
        now: () => nowMs,
      },
    );
    const sessionId = "budget-cooldown-bypass";

    manager.beginTurn(sessionId, 1);
    manager.markCompacted(sessionId);

    manager.beginTurn(sessionId, 2);
    nowMs += 1_000;
    const pressure = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_820,
      contextWindow: 2_000,
      percent: 0.91,
    });
    expect(pressure.shouldCompact).toBe(true);
    expect(pressure.reason).toBe("usage_threshold");

    manager.beginTurn(sessionId, 3);
    nowMs += 1_000;
    const hardLimit = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_900,
      contextWindow: 2_000,
      percent: 0.95,
    });
    expect(hardLimit.shouldCompact).toBe(true);
    expect(hardLimit.reason).toBe("hard_limit");
  });

  test("normalizes percentage-point context usage into ratio", () => {
    const manager = new ContextBudgetManager({
      ...DEFAULT_ROASTER_CONFIG.infrastructure.contextBudget,
    });
    const sessionId = "budget-percent-points";

    manager.beginTurn(sessionId, 1);
    const lowUsage = manager.shouldRequestCompaction(sessionId, {
      tokens: 3_597,
      contextWindow: 272_000,
      // 1.322% from upstream telemetry, not 132.2%
      percent: 1.3224264705882354,
    });
    expect(lowUsage.shouldCompact).toBe(false);

    const injection = manager.planInjection(sessionId, "hello", {
      tokens: 3_597,
      contextWindow: 272_000,
      percent: 1.3224264705882354,
    });
    expect(injection.accepted).toBe(true);

    const highUsage = manager.shouldRequestCompaction(sessionId, {
      tokens: 258_400,
      contextWindow: 272_000,
      // 95% in percentage-point form
      percent: 95,
    });
    expect(highUsage.shouldCompact).toBe(true);
    expect(highUsage.reason).toBe("hard_limit");
  });
});
