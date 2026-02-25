import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-004/S-005 verification gate", () => {
  test("blocks without evidence after write and passes with evidence", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s4";

    runtime.tools.markCall(sessionId, "edit");
    const blocked = runtime.verification.evaluate(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("lsp_diagnostics");
    expect(blocked.missingEvidence).toContain("test_or_build");

    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "All tests passed",
      success: true,
    });

    const passed = runtime.verification.evaluate(sessionId);
    expect(passed.passed).toBe(true);
  });

  test("treats multi_edit as a mutation tool for verification gating", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s4-multi-edit";

    runtime.tools.markCall(sessionId, "multi_edit");
    const blocked = runtime.verification.evaluate(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("lsp_diagnostics");
    expect(blocked.missingEvidence).toContain("test_or_build");
  });
});
