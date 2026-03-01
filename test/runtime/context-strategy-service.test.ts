import { describe, expect, test } from "bun:test";
import type { ContextEvolutionManager } from "../../packages/brewva-runtime/src/context/evolution-manager.js";
import type { ContextStabilityMonitor } from "../../packages/brewva-runtime/src/context/stability-monitor.js";
import { ContextStrategyService } from "../../packages/brewva-runtime/src/services/context-strategy.js";
import type { BrewvaEventRecord } from "../../packages/brewva-runtime/src/types.js";

type CapturedEvent = {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
};

describe("ContextStrategyService", () => {
  test("emits transition and strategy events with stable payloads", () => {
    const events: CapturedEvent[] = [];
    let clearCalls = 0;
    let resolveCalls = 0;

    const stabilityMonitor = {
      clearSession: () => {
        clearCalls += 1;
      },
    } as unknown as ContextStabilityMonitor;

    const evolution = {
      resolve: () => {
        resolveCalls += 1;
        return {
          arm: "managed",
          armSource: "default",
          model: "gpt-test",
          taskClass: "skill-x",
          adaptiveZonesEnabled: false,
          stabilityMonitorEnabled: false,
          transitions:
            resolveCalls === 1
              ? [
                  {
                    feature: "adaptiveZones",
                    metricKey: "floor_unmet_rate_7d",
                    metricValue: 0.34,
                    sampleSize: 41,
                    toEnabled: false,
                  },
                ]
              : [],
        };
      },
    } as unknown as ContextEvolutionManager;

    const service = new ContextStrategyService({
      contextEvolution: evolution,
      stabilityMonitor,
      getCurrentTurn: () => 5,
      getSessionModel: () => "gpt-test",
      getTaskClass: () => "skill-x",
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const first = service.resolve({
      sessionId: "strategy-session",
    });
    const second = service.resolve({
      sessionId: "strategy-session",
    });

    expect(first.arm).toBe("managed");
    expect(second.arm).toBe("managed");
    expect(clearCalls).toBe(2);

    const featureDisabled = events.find(
      (event) => event.type === "context_evolution_feature_disabled",
    );
    expect(featureDisabled).toBeDefined();
    expect(featureDisabled?.payload).toEqual(
      expect.objectContaining({
        feature: "adaptiveZones",
        metricKey: "floor_unmet_rate_7d",
        metricValue: 0.34,
        sampleSize: 41,
      }),
    );

    const strategySelected = events.filter((event) => event.type === "context_strategy_selected");
    expect(strategySelected).toHaveLength(1);
    expect(strategySelected[0]?.payload).toEqual(
      expect.objectContaining({
        arm: "managed",
        source: "default",
        adaptiveZonesEnabled: false,
        stabilityMonitorEnabled: false,
        model: "gpt-test",
        taskClass: "skill-x",
      }),
    );
  });

  test("returns deterministic simple decision when evolution manager is absent", () => {
    let clearCalls = 0;
    const events: CapturedEvent[] = [];

    const stabilityMonitor = {
      clearSession: () => {
        clearCalls += 1;
      },
    } as unknown as ContextStabilityMonitor;

    const service = new ContextStrategyService({
      contextEvolution: null,
      stabilityMonitor,
      getCurrentTurn: () => 2,
      getSessionModel: () => "gpt-simple",
      getTaskClass: () => "(none)",
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const decision = service.resolve({
      sessionId: "simple-session",
    });

    expect(decision.arm).toBe("managed");
    expect(decision.armSource).toBe("default");
    expect(decision.adaptiveZonesEnabled).toBe(false);
    expect(decision.stabilityMonitorEnabled).toBe(false);
    expect(clearCalls).toBe(1);
    expect(events).toHaveLength(0);
  });
});
