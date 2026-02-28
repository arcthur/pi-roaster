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
  config.infrastructure.contextBudget.strategy.defaultArm = "passthrough";
  config.infrastructure.contextBudget.strategy.enableAutoByContextWindow = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = false;
  return config;
}

describe("context strategy integration", () => {
  test("passthrough arm bypasses maxInjectionTokens cap while keeping context accepted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-context-strategy-int-"));
    writeFileSync(
      join(workspace, "AGENTS.md"),
      ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    const sessionId = "context-strategy-int-1";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "passthrough check " + "x".repeat(4_000),
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:passthrough",
      kind: "diagnostic",
      severity: "warn",
      summary: "passthrough summary " + "y".repeat(4_000),
    });

    const result = await runtime.context.buildInjection(sessionId, "run passthrough strategy");
    expect(result.accepted).toBe(true);
    expect(result.finalTokens).toBeGreaterThan(100);

    const strategySelected = runtime.events.query(sessionId, {
      type: "context_strategy_selected",
      last: 1,
    })[0];
    expect(strategySelected).toBeDefined();
    const payload = strategySelected?.payload as { arm?: string } | undefined;
    expect(payload?.arm).toBe("passthrough");
  });
});
