import { describe, expect, test } from "bun:test";
import {
  ContextEvolutionManager,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaConfig,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";

function createEvent(
  sessionId: string,
  type: string,
  timestamp: number,
  payload?: Record<string, unknown>,
): BrewvaEventRecord {
  return {
    id: `${sessionId}-${type}-${timestamp}`,
    sessionId,
    type,
    timestamp,
    payload: payload as BrewvaEventRecord["payload"],
  };
}

describe("ContextEvolutionManager", () => {
  test("always resolves to managed arm", () => {
    const config: BrewvaConfig = structuredClone(DEFAULT_BREWVA_CONFIG);

    const manager = new ContextEvolutionManager({
      config: config.infrastructure.contextBudget,
      listSessionIds: () => [],
      listEvents: () => [],
    });

    const decision = manager.resolve({
      sessionId: "ctx-evolution-managed",
      model: "claude-sonnet",
      taskClass: "patching",
    });

    expect(decision.arm).toBe("managed");
    expect(decision.armSource).toBe("default");
  });

  test("retires and re-enables stability monitor from floor_unmet metric", () => {
    const nowRef = { value: Date.now() };
    const sessionId = "ctx-evolution-stability";
    let events: BrewvaEventRecord[] = [
      createEvent(sessionId, "cost_update", nowRef.value - 1000, { model: "claude-sonnet" }),
      createEvent(sessionId, "skill_activated", nowRef.value - 900, { skillName: "patching" }),
      createEvent(sessionId, "context_injected", nowRef.value - 800, { sourceTokens: 400 }),
      createEvent(sessionId, "context_injected", nowRef.value - 700, { sourceTokens: 420 }),
      createEvent(sessionId, "context_injected", nowRef.value - 600, { sourceTokens: 410 }),
    ];

    const config: BrewvaConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.stabilityMonitor.enabled = true;
    config.infrastructure.contextBudget.stabilityMonitor.retirement = {
      enabled: true,
      metricKey: "floor_unmet_rate_7d",
      disableBelow: 0.2,
      reenableAbove: 0.6,
      checkIntervalHours: 1,
      minSamples: 3,
    };

    const manager = new ContextEvolutionManager({
      config: config.infrastructure.contextBudget,
      listSessionIds: () => [sessionId],
      listEvents: () => events,
      now: () => nowRef.value,
    });

    const disabled = manager.resolve({
      sessionId,
      model: "claude-sonnet",
      taskClass: "patching",
    });
    expect(disabled.stabilityMonitorEnabled).toBe(false);
    expect(disabled.transitions.some((item) => item.feature === "stabilityMonitor")).toBe(true);

    nowRef.value += 2 * 60 * 60 * 1000;
    events = [
      createEvent(sessionId, "cost_update", nowRef.value - 1000, { model: "claude-sonnet" }),
      createEvent(sessionId, "skill_activated", nowRef.value - 900, { skillName: "patching" }),
      createEvent(sessionId, "context_arena_floor_unmet_unrecoverable", nowRef.value - 800),
      createEvent(sessionId, "context_arena_floor_unmet_unrecoverable", nowRef.value - 700),
      createEvent(sessionId, "context_arena_floor_unmet_unrecoverable", nowRef.value - 600),
      createEvent(sessionId, "context_injected", nowRef.value - 500, { sourceTokens: 350 }),
      createEvent(sessionId, "context_injection_dropped", nowRef.value - 400, {
        reason: "floor_unmet",
      }),
      createEvent(sessionId, "context_injection_dropped", nowRef.value - 300, {
        reason: "floor_unmet",
      }),
    ];

    const reenabled = manager.resolve({
      sessionId,
      model: "claude-sonnet",
      taskClass: "patching",
    });
    expect(reenabled.stabilityMonitorEnabled).toBe(true);
    expect(
      reenabled.transitions.some((item) => item.feature === "stabilityMonitor" && item.toEnabled),
    ).toBe(true);
  });
});
