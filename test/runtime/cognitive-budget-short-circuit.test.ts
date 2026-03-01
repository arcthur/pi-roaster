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
  config.memory.enabled = true;
  config.memory.cognitive.mode = "shadow";
  config.memory.cognitive.maxTokensPerTurn = 0;
  config.memory.externalRecall.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.verification.checks.quick = ["type-check"];
  config.verification.checks.standard = ["type-check", "tests"];
  config.verification.checks.strict = ["type-check", "tests"];
  config.verification.commands["type-check"] = "true";
  config.verification.commands.tests = "false";
  return config;
}

describe("cognitive budget short-circuit", () => {
  test("does not call memory cognitive ranker when maxTokensPerTurn is zero", async () => {
    let rankCalls = 0;
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("brewva-cognitive-zero-memory-"),
      config: createConfig(),
      cognitivePort: {
        rankRelevance: () => {
          rankCalls += 1;
          return {
            scores: [],
            usage: { totalTokens: 5 },
          };
        },
      },
    });
    const sessionId = "cognitive-zero-memory";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "false" },
      outputText: "memory ranking test first failure",
      success: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "false" },
      outputText: "memory ranking test second failure",
      success: false,
    });

    runtime.memory.refreshIfNeeded({ sessionId });
    const result = await runtime.memory.search(sessionId, {
      query: "failure",
      limit: 8,
    });

    expect(result.hits.length).toBeGreaterThan(1);
    expect(rankCalls).toBe(0);
  });

  test("does not call verification cognitive reflection when maxTokensPerTurn is zero", async () => {
    let reflectionCalls = 0;
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("brewva-cognitive-zero-verification-"),
      config: createConfig(),
      cognitivePort: {
        reflectOnOutcome: () => {
          reflectionCalls += 1;
          return {
            lesson: "should never be emitted with zero cognitive budget",
            usage: { totalTokens: 9 },
          };
        },
      },
    });
    const sessionId = "cognitive-zero-verification";

    runtime.tools.markCall(sessionId, "edit");
    const report = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });

    expect(report.passed).toBe(false);
    expect(reflectionCalls).toBe(0);
    const reflectionEvent = runtime.events.query(sessionId, {
      type: "cognitive_outcome_reflection",
      last: 1,
    })[0];
    expect(reflectionEvent).toBeUndefined();
  });
});
