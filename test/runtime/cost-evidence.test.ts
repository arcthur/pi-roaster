import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("cost evidence separation in digest", () => {
  test("given ledger and infrastructure cost records, when building digest, then infrastructure entries are excluded", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = `cost-sep-${Date.now()}`;

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo hello" },
      outputText: "hello",
      success: true,
    });

    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.001,
    });

    const digest = runtime.truth.getLedgerDigest(sessionId);
    expect(digest).toContain("count=1");
    expect(digest).not.toContain("brewva_cost");
  });
});
