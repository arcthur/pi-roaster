import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-003 ledger write/query", () => {
  test("given recorded tool result, when querying recent ledger entries, then text includes tool and output", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s3";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS",
      success: true,
    });

    const text = runtime.truth.queryLedger(sessionId, { last: 5 });
    expect(text.includes("exec")).toBe(true);
    expect(text.includes("PASS")).toBe(true);
  });
});
