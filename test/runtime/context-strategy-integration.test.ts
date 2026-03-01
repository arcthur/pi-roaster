import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.contextBudget.enabled = true;
  config.infrastructure.contextBudget.profile = "managed";
  config.infrastructure.contextBudget.maxInjectionTokens = 100;
  config.infrastructure.contextBudget.truncationStrategy = "tail";
  config.infrastructure.contextBudget.floorUnmetPolicy.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = false;
  return config;
}

describe("context strategy integration", () => {
  test("managed arm keeps maxInjectionTokens cap while context remains accepted", async () => {
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
      goal: "managed check " + "x".repeat(4_000),
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:managed",
      kind: "diagnostic",
      severity: "warn",
      summary: "managed summary " + "y".repeat(4_000),
    });

    const result = await runtime.context.buildInjection(sessionId, "run managed strategy");
    expect(result.accepted).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(100);

    const strategySelected = runtime.events.query(sessionId, {
      type: "context_strategy_selected",
      last: 1,
    })[0];
    expect(strategySelected).toBeDefined();
    const payload = strategySelected?.payload as { arm?: string } | undefined;
    expect(payload?.arm).toBe("managed");
  });
});
