import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: cost view and budget linkage", () => {
  test("allocates cost usage across tools based on call counts in the same turn", async () => {
    const workspace = createWorkspace("cost-allocation");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "cost-allocation-1";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.markCall(sessionId, "read");
    runtime.tools.markCall(sessionId, "read");
    runtime.tools.markCall(sessionId, "grep");

    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 300,
      costUsd: 0.03,
    });

    const summary = runtime.cost.getSummary(sessionId);
    expect(summary.tools.read?.callCount).toBe(2);
    expect(summary.tools.grep?.callCount).toBe(1);
    expect(summary.tools.read?.allocatedTokens).toBeCloseTo(200, 3);
    expect(summary.tools.grep?.allocatedTokens).toBeCloseTo(100, 3);
    expect(summary.tools.read?.allocatedCostUsd).toBeCloseTo(0.02, 6);
    expect(summary.tools.grep?.allocatedCostUsd).toBeCloseTo(0.01, 6);
  });

  test("tracks skill/tool breakdown and blocks tools when budget action is block_tools", async () => {
    const workspace = createWorkspace("cost");
    writeConfig(workspace, createConfig({
      infrastructure: {
        costTracking: {
          maxCostUsdPerSession: 0.01,
          alertThresholdRatio: 0.5,
          actionOnExceed: "block_tools",
        },
      },
    }));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "cost-1";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.02,
    });

    const summary = runtime.cost.getSummary(sessionId);
    expect(summary.totalCostUsd).toBeGreaterThan(0.01);
    expect(summary.budget.blocked).toBe(true);
    expect(summary.budget.skillExceeded).toBe(false);
    expect(summary.skills["(none)"]).toBeDefined();
    expect(summary.tools.edit?.callCount).toBe(1);

    const access = runtime.tools.checkAccess(sessionId, "read");
    expect(access.allowed).toBe(false);
    expect(runtime.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "session_compact").allowed).toBe(true);
  });

  test("enforces global skill budget status consistently with tool access checks", async () => {
    const workspace = createWorkspace("cost-budget-consistency");
    writeConfig(workspace, createConfig({
      infrastructure: {
        costTracking: {
          maxCostUsdPerSession: 0.001,
          alertThresholdRatio: 0.5,
          actionOnExceed: "block_tools",
        },
      },
    }));
    mkdirSync(join(workspace, "skills/base/patching"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/base/patching/SKILL.md"),
      `---
name: patching
description: test patching skill
tier: base
tags: [patching]
tools:
  required: [read]
  optional: [edit]
  denied: [write]
budget:
  max_tool_calls: 20
  max_tokens: 20000
---
patching`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "cost-budget-consistency-1";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "read");
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 60,
      costUsd: 0.002,
    });
    expect(runtime.skills.activate(sessionId, "patching").ok).toBe(true);

    const summary = runtime.cost.getSummary(sessionId);
    expect(summary.budget.skillExceeded).toBe(false);
    expect(summary.budget.blocked).toBe(true);

    const access = runtime.tools.checkAccess(sessionId, "read");
    expect(access.allowed).toBe(false);
    expect(runtime.tools.checkAccess(sessionId, "skill_complete").allowed).toBe(true);
    expect(runtime.tools.checkAccess(sessionId, "session_compact").allowed).toBe(true);
  });
});
