import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.contextBudget.enabled = true;
  config.infrastructure.contextBudget.maxInjectionTokens = 100;
  config.infrastructure.contextBudget.truncationStrategy = "tail";
  config.infrastructure.contextBudget.floorUnmetPolicy.enabled = false;
  config.infrastructure.contextBudget.floorUnmetPolicy.requestCompaction = true;
  config.infrastructure.contextBudget.arena.zones.truth = { min: 20, max: 420 };
  config.infrastructure.contextBudget.arena.zones.toolFailures = { min: 96, max: 320 };
  config.infrastructure.contextBudget.stabilityMonitor.enabled = true;
  config.infrastructure.contextBudget.stabilityMonitor.consecutiveThreshold = 2;
  config.infrastructure.toolFailureInjection.enabled = true;
  config.memory.enabled = false;
  return config;
}

function createAutoArmConfig(): BrewvaConfig {
  const config = createConfig();
  config.infrastructure.contextBudget.strategy.defaultArm = "managed";
  config.infrastructure.contextBudget.strategy.enableAutoByContextWindow = true;
  config.infrastructure.contextBudget.strategy.hybridContextWindowMin = 800;
  config.infrastructure.contextBudget.strategy.passthroughContextWindowMin = 1_000;
  return config;
}

describe("context stability monitor integration", () => {
  test("trips on consecutive floor_unmet and does not auto-reset on forced success", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-stability-int-"));
    writeFileSync(
      join(workspace, "AGENTS.md"),
      ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    const sessionId = "context-stability-int-1";
    const recordFailure = () =>
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: "bun test" },
        outputText: "Error: synthetic failure " + "x".repeat(4_000),
        success: false,
      });

    runtime.context.onTurnStart(sessionId, 1);
    recordFailure();
    const first = await runtime.context.buildInjection(sessionId, "turn-1");
    expect(first.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 3000, toTokens: 500 });

    runtime.context.onTurnStart(sessionId, 2);
    recordFailure();
    const second = await runtime.context.buildInjection(sessionId, "turn-2");
    expect(second.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 2800, toTokens: 450 });

    const tripped = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(tripped).toHaveLength(1);

    runtime.context.onTurnStart(sessionId, 3);
    recordFailure();
    const third = await runtime.context.buildInjection(sessionId, "turn-3");
    expect(third.accepted).toBe(true);
    expect(third.text.includes("[RecentToolFailures]")).toBe(false);

    const resetEvents = runtime.events.query(sessionId, {
      type: "context_stability_monitor_reset",
    });
    expect(resetEvents).toHaveLength(0);

    runtime.session.clearState(sessionId);

    runtime.context.onTurnStart(sessionId, 4);
    recordFailure();
    const afterClearFirst = await runtime.context.buildInjection(sessionId, "after-clear-turn-1");
    expect(afterClearFirst.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 2600, toTokens: 410 });

    const trippedAfterOneTurn = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedAfterOneTurn).toHaveLength(1);

    runtime.context.onTurnStart(sessionId, 5);
    recordFailure();
    const afterClearSecond = await runtime.context.buildInjection(sessionId, "after-clear-turn-2");
    expect(afterClearSecond.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 2400, toTokens: 390 });

    const trippedAfterTwoTurns = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedAfterTwoTurns).toHaveLength(2);
  });

  test("does not count repeated degraded plans in the same turn as consecutive turns", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-stability-int-same-turn-"));
    writeFileSync(
      join(workspace, "AGENTS.md"),
      ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    const sessionId = "context-stability-int-same-turn";
    const recordFailure = () =>
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: "bun test" },
        outputText: "Error: synthetic failure " + "x".repeat(4_000),
        success: false,
      });

    runtime.context.onTurnStart(sessionId, 1);
    recordFailure();
    const first = await runtime.context.buildInjection(sessionId, "turn-1-a");
    expect(first.accepted).toBe(false);

    recordFailure();
    const second = await runtime.context.buildInjection(sessionId, "turn-1-b");
    expect(second.accepted).toBe(false);

    const trippedAfterSameTurn = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedAfterSameTurn).toHaveLength(0);

    runtime.context.onTurnStart(sessionId, 2);
    recordFailure();
    const third = await runtime.context.buildInjection(sessionId, "turn-2");
    expect(third.accepted).toBe(false);

    const trippedAfterSecondTurn = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedAfterSecondTurn).toHaveLength(1);
  });

  test("clears stale stabilized state when strategy arm disables monitor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-stability-int-strategy-switch-"));
    writeFileSync(
      join(workspace, "AGENTS.md"),
      ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createAutoArmConfig(),
    });
    const sessionId = "context-stability-int-switch";
    const recordFailure = () =>
      runtime.tools.recordResult({
        sessionId,
        toolName: "exec",
        args: { command: "bun test" },
        outputText: "Error: synthetic failure " + "x".repeat(4_000),
        success: false,
      });

    runtime.context.onTurnStart(sessionId, 1);
    recordFailure();
    const first = await runtime.context.buildInjection(sessionId, "turn-1", {
      tokens: 800,
      contextWindow: 500,
      percent: 0.2,
    });
    expect(first.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 3000, toTokens: 500 });

    runtime.context.onTurnStart(sessionId, 2);
    recordFailure();
    const second = await runtime.context.buildInjection(sessionId, "turn-2", {
      tokens: 820,
      contextWindow: 500,
      percent: 0.21,
    });
    expect(second.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 2800, toTokens: 450 });

    const trippedBeforeSwitch = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedBeforeSwitch).toHaveLength(1);

    runtime.context.onTurnStart(sessionId, 3);
    recordFailure();
    const passthrough = await runtime.context.buildInjection(sessionId, "turn-3", {
      tokens: 900,
      contextWindow: 2_000,
      percent: 0.1,
    });
    expect(passthrough.accepted).toBe(true);
    runtime.context.markCompacted(sessionId, { fromTokens: 2500, toTokens: 420 });

    runtime.context.onTurnStart(sessionId, 4);
    recordFailure();
    const afterSwitchFirst = await runtime.context.buildInjection(sessionId, "turn-4", {
      tokens: 840,
      contextWindow: 500,
      percent: 0.2,
    });
    expect(afterSwitchFirst.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 2300, toTokens: 400 });

    const trippedAfterSwitchFirst = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedAfterSwitchFirst).toHaveLength(1);

    runtime.context.onTurnStart(sessionId, 5);
    recordFailure();
    const afterSwitchSecond = await runtime.context.buildInjection(sessionId, "turn-5", {
      tokens: 860,
      contextWindow: 500,
      percent: 0.21,
    });
    expect(afterSwitchSecond.accepted).toBe(false);
    runtime.context.markCompacted(sessionId, { fromTokens: 2100, toTokens: 380 });

    const trippedAfterSwitchSecond = runtime.events.query(sessionId, {
      type: "context_stability_monitor_tripped",
    });
    expect(trippedAfterSwitchSecond).toHaveLength(2);
  });
});
