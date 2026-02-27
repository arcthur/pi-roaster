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
  config.infrastructure.contextBudget.arena.zones.truth = { min: 500, max: 1000 };
  config.infrastructure.contextBudget.arena.zones.taskState = { min: 500, max: 1000 };
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = false;
  return config;
}

describe("context arena floor unmet", () => {
  test("emits context_arena_floor_unmet_unrecoverable when zone floors exceed available budget", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-arena-floor-unmet-"));
    writeFileSync(
      join(workspace, "AGENTS.md"),
      ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
      "utf8",
    );
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    const sessionId = "arena-floor-unmet";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "force floor unmet " + "g".repeat(3_000),
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:floor",
      kind: "diagnostic",
      severity: "warn",
      summary: "floor unmet fact " + "f".repeat(3_000),
    });

    const result = await runtime.context.buildInjection(sessionId, "force floor unmet");
    expect(result.accepted).toBe(false);
    expect(result.text).toBe("");

    const event = runtime.events.query(sessionId, {
      type: "context_arena_floor_unmet_unrecoverable",
      last: 1,
    })[0];
    expect(event).toBeDefined();
    const payload = event?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("insufficient_budget_for_zone_floors");
  });
});
