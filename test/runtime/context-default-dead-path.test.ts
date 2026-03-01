import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(workspace, "AGENTS.md"),
    ["## CRITICAL RULES", "- User-facing command name is `brewva`."].join("\n"),
    "utf8",
  );
  return workspace;
}

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.contextBudget.enabled = true;
  config.infrastructure.contextBudget.profile = "managed";
  config.infrastructure.contextBudget.maxInjectionTokens = 1200;
  config.memory.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  return config;
}

describe("context default dead-path", () => {
  test("does not emit context_arena_* or context_stability_* events with managed profile and zero floors", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("brewva-context-default-dead-path-"),
      config: createConfig(),
    });
    const sessionId = "context-default-dead-path";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "validate default allocator path",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:default-dead-path",
      kind: "diagnostic",
      severity: "info",
      summary: "default floor config should avoid floor_unmet control loop",
    });

    await runtime.context.buildInjection(sessionId, "run baseline injection", {
      tokens: 300,
      contextWindow: 1000,
      percent: 0.3,
    });

    const events = runtime.events.query(sessionId);
    const arenaEvents = events.filter((event) => event.type.startsWith("context_arena_"));
    const stabilityEvents = events.filter((event) => event.type.startsWith("context_stability_"));

    expect(arenaEvents).toHaveLength(0);
    expect(stabilityEvents).toHaveLength(0);
  });
});
