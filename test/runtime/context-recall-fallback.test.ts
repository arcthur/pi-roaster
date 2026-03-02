import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

function createConfig(recallMode: BrewvaConfig["memory"]["recallMode"]): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = true;
  config.memory.recallMode = recallMode;
  return config;
}

function patchMemory(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.contextService.memory.refreshIfNeeded = () => undefined;
  runtimeWithInternals.contextService.memory.getWorkingMemory = () => ({
    content: "[WorkingMemory]\nsummary: deterministic working memory",
  });
  runtimeWithInternals.contextService.memory.buildRecallBlock = async () =>
    "[MemoryRecall]\nquery: deterministic recall";
}

describe("recall pressure-aware mode", () => {
  test("skips recall under high pressure when recallMode=pressure-aware", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-recall-fallback-high-")),
      config: createConfig("pressure-aware"),
    });
    patchMemory(runtime);

    const result = await runtime.context.buildInjection(
      "recall-pressure-aware-high",
      "memory recall gating",
      { tokens: 900, contextWindow: 1000, percent: 0.9 },
    );
    expect(result.accepted).toBe(true);
    expect(result.text.includes("[WorkingMemory]")).toBe(true);
    expect(result.text.includes("[MemoryRecall]")).toBe(false);
  });

  test("includes recall under low pressure when recallMode=pressure-aware", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-recall-fallback-low-")),
      config: createConfig("pressure-aware"),
    });
    patchMemory(runtime);

    const result = await runtime.context.buildInjection(
      "recall-pressure-aware-low",
      "memory recall gating",
      { tokens: 100, contextWindow: 1000, percent: 0.1 },
    );
    expect(result.accepted).toBe(true);
    expect(result.text.includes("[WorkingMemory]")).toBe(true);
    expect(result.text.includes("[MemoryRecall]")).toBe(true);
  });

  test("keeps recall enabled under high pressure when recallMode=always", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-recall-primary-high-")),
      config: createConfig("always"),
    });
    patchMemory(runtime);

    const result = await runtime.context.buildInjection(
      "recall-always-high",
      "memory recall gating",
      { tokens: 900, contextWindow: 1000, percent: 0.9 },
    );
    expect(result.accepted).toBe(true);
    expect(result.text.includes("[WorkingMemory]")).toBe(true);
    expect(result.text.includes("[MemoryRecall]")).toBe(true);
  });
});
