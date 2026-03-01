import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

type RuntimeWithInternals = {
  contextService: {
    memory: {
      refreshIfNeeded(input: { sessionId: string }): void;
      getWorkingMemory(sessionId: string): { content: string } | null;
      buildRecallBlock(input: {
        sessionId: string;
        query: string;
        limit?: number;
      }): Promise<string>;
    };
  };
};

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-context-order-${name}-`));
  mkdirSync(join(workspace, ".brewva", "agents", "default"), { recursive: true });
  writeFileSync(
    join(workspace, ".brewva", "agents", "default", "identity.md"),
    ["[Identity]", "role: runtime ordering probe"].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "## CRITICAL RULES",
      "- User-facing command name is `brewva`.",
      "- Use workspace package imports `@brewva/brewva-runtime`.",
      "- Run bun run test:dist before release-sensitive changes.",
    ].join("\n"),
    "utf8",
  );
  return workspace;
}

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.memory.enabled = true;
  config.memory.recallMode = "primary";
  config.infrastructure.contextBudget.enabled = true;
  config.infrastructure.contextBudget.profile = "managed";
  config.infrastructure.contextBudget.maxInjectionTokens = 4_000;
  config.infrastructure.toolFailureInjection.enabled = true;
  return config;
}

function patchMemory(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.contextService.memory.refreshIfNeeded = () => undefined;
  runtimeWithInternals.contextService.memory.getWorkingMemory = () => ({
    content: "[WorkingMemory]\nsummary: deterministic working memory block",
  });
  runtimeWithInternals.contextService.memory.buildRecallBlock = async () =>
    "[MemoryRecall]\nquery: deterministic recall block";
}

describe("context source order integration", () => {
  test("injects all seven semantic sources in deterministic zone order", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("seven-sources"),
      config: createConfig(),
      agentId: "default",
    });
    patchMemory(runtime);

    const sessionId = "context-source-order";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Validate semantic source ordering",
      constraints: ["Keep deterministic source order"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "tool failure blocks completion",
      source: "test",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:order",
      kind: "diagnostic",
      severity: "warn",
      summary: "deterministic truth fact",
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: deterministic failure",
      success: false,
    });

    const injected = await runtime.context.buildInjection(
      sessionId,
      "verify context source ordering",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "leaf-order",
    );
    expect(injected.accepted).toBe(true);

    const markers = [
      "[Identity]",
      "[TruthLedger]",
      "[TruthFacts]",
      "[TaskLedger]",
      "[RecentToolFailures]",
      "[WorkingMemory]",
      "[MemoryRecall]",
    ];
    for (const marker of markers) {
      expect(injected.text.includes(marker)).toBe(true);
    }

    let previousIndex = -1;
    for (const marker of markers) {
      const index = injected.text.indexOf(marker);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
