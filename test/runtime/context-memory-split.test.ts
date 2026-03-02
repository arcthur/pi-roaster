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

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = true;
  config.memory.recallMode = "always";
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

function getLastInjectedSourceCount(runtime: BrewvaRuntime, sessionId: string): number {
  const event = runtime.events.query(sessionId, { type: "context_injected", last: 1 })[0];
  const payload = event?.payload as { sourceCount?: number } | undefined;
  return payload?.sourceCount ?? 0;
}

describe("context memory split", () => {
  test("registers working and recall as independent semantic sources", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-split-"));
    const sessionId = "memory-split";
    const prompt = "deterministic memory split";

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig(),
    });
    patchMemory(runtime);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "baseline task state",
    });

    const injection = await runtime.context.buildInjection(sessionId, prompt);
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[WorkingMemory]")).toBe(true);
    expect(injection.text.includes("[MemoryRecall]")).toBe(true);
    const sourceCount = getLastInjectedSourceCount(runtime, sessionId);
    expect(sourceCount).toBeGreaterThanOrEqual(3);
  });
});
