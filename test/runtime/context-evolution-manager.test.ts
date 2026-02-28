import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("chooses passthrough arm automatically for very large context windows", () => {
    const config: BrewvaConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.strategy.enableAutoByContextWindow = true;
    config.infrastructure.contextBudget.strategy.hybridContextWindowMin = 200_000;
    config.infrastructure.contextBudget.strategy.passthroughContextWindowMin = 1_000_000;

    const manager = new ContextEvolutionManager({
      config: config.infrastructure.contextBudget,
      workspaceRoot: process.cwd(),
      listSessionIds: () => [],
      listEvents: () => [],
    });

    const decision = manager.resolve({
      sessionId: "ctx-evolution-1",
      model: "claude-sonnet",
      taskClass: "patching",
      contextWindow: 1_500_000,
    });

    expect(decision.arm).toBe("passthrough");
    expect(decision.armSource).toBe("auto_context_window");
    expect(decision.adaptiveZonesEnabled).toBe(false);
    expect(decision.stabilityMonitorEnabled).toBe(false);
  });

  test("prefers override arm from strategy file with model/task match", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-context-strategy-"));
    const overridesPath = join(workspace, ".brewva", "strategy", "context-strategy.json");
    mkdirSync(join(workspace, ".brewva", "strategy"), { recursive: true });
    writeFileSync(
      overridesPath,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              id: "ovr-1",
              model: "claude-sonnet",
              taskClass: "patching",
              arm: "hybrid",
              updatedAt: Date.now(),
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config: BrewvaConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.strategy.overridesPath =
      ".brewva/strategy/context-strategy.json";
    const manager = new ContextEvolutionManager({
      config: config.infrastructure.contextBudget,
      workspaceRoot: workspace,
      listSessionIds: () => [],
      listEvents: () => [],
    });

    const decision = manager.resolve({
      sessionId: "ctx-evolution-2",
      model: "claude-sonnet",
      taskClass: "patching",
      contextWindow: 32_000,
    });

    expect(decision.arm).toBe("hybrid");
    expect(decision.armSource).toBe("override");
    expect(decision.armOverrideId).toBe("ovr-1");
  });

  test("keeps last valid overrides when strategy file is temporarily invalid", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-context-strategy-invalid-"));
    const overridesPath = join(workspace, ".brewva", "strategy", "context-strategy.json");
    mkdirSync(join(workspace, ".brewva", "strategy"), { recursive: true });
    writeFileSync(
      overridesPath,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              id: "ovr-valid-1",
              model: "claude-sonnet",
              taskClass: "patching",
              arm: "hybrid",
              updatedAt: Date.now(),
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config: BrewvaConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.strategy.overridesPath =
      ".brewva/strategy/context-strategy.json";
    const manager = new ContextEvolutionManager({
      config: config.infrastructure.contextBudget,
      workspaceRoot: workspace,
      listSessionIds: () => [],
      listEvents: () => [],
    });

    const beforeInvalid = manager.resolve({
      sessionId: "ctx-evolution-invalid-1",
      model: "claude-sonnet",
      taskClass: "patching",
      contextWindow: 64_000,
    });
    expect(beforeInvalid.arm).toBe("hybrid");
    expect(beforeInvalid.armSource).toBe("override");
    expect(beforeInvalid.armOverrideId).toBe("ovr-valid-1");

    writeFileSync(overridesPath, "{", "utf8");

    const afterInvalid = manager.resolve({
      sessionId: "ctx-evolution-invalid-2",
      model: "claude-sonnet",
      taskClass: "patching",
      contextWindow: 64_000,
    });
    expect(afterInvalid.arm).toBe("hybrid");
    expect(afterInvalid.armSource).toBe("override");
    expect(afterInvalid.armOverrideId).toBe("ovr-valid-1");
  });

  test("retires and re-enables stability monitor from floor_unmet metric", () => {
    const nowRef = { value: Date.now() };
    const sessionId = "ctx-evolution-3";
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
      workspaceRoot: process.cwd(),
      listSessionIds: () => [sessionId],
      listEvents: () => events,
      now: () => nowRef.value,
    });

    const disabled = manager.resolve({
      sessionId,
      model: "claude-sonnet",
      taskClass: "patching",
      contextWindow: 64_000,
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
      contextWindow: 64_000,
    });
    expect(reenabled.stabilityMonitorEnabled).toBe(true);
    expect(
      reenabled.transitions.some((item) => item.feature === "stabilityMonitor" && item.toEnabled),
    ).toBe(true);
  });
});
