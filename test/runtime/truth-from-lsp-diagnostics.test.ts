import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Truth extraction from lsp_diagnostics", () => {
  test("records diagnostic truth facts and resolves on clean output", () => {
    const workspace = createWorkspace("truth-from-lsp-diagnostics");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-lsp-diagnostics-1";

    const diagnosticsOutput = [
      "src/foo.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
    ].join("\n");

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts" },
      outputText: diagnosticsOutput,
      success: true,
    });

    const truth1 = runtime.getTruthState(sessionId);
    const fact1 = truth1.facts.find((fact) => fact.kind === "diagnostic");
    expect(fact1).not.toBeUndefined();
    expect(fact1?.status).toBe("active");
    expect(fact1?.summary.includes("TS2322")).toBe(true);

    const task1 = runtime.getTaskState(sessionId);
    const blocker1 = task1.blockers.find((blocker) => blocker.id === fact1?.id);
    expect(blocker1).not.toBeUndefined();
    expect(blocker1?.truthFactId).toBe(fact1?.id);

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts" },
      outputText: "No diagnostics found",
      success: true,
    });

    const truth2 = runtime.getTruthState(sessionId);
    const fact2 = truth2.facts.find((fact) => fact.id === fact1?.id);
    expect(fact2).not.toBeUndefined();
    expect(fact2?.status).toBe("resolved");

    const task2 = runtime.getTaskState(sessionId);
    expect(task2.blockers.some((blocker) => blocker.id === fact1?.id)).toBe(
      false,
    );
  });

  test("clean output resolves only diagnostic facts for that file", () => {
    const workspace = createWorkspace("truth-from-lsp-diagnostics-scoped");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-lsp-diagnostics-2";

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts" },
      outputText:
        "src/foo.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      success: true,
    });

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/bar.ts" },
      outputText: "src/bar.ts(2,1): error TS2304: Cannot find name 'bar'.",
      success: true,
    });

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts" },
      outputText: "No diagnostics found",
      success: true,
    });

    const truth = runtime.getTruthState(sessionId);
    const foo = truth.facts.find(
      (fact) =>
        fact.summary.includes("src/foo.ts") && fact.summary.includes("TS2322"),
    );
    const bar = truth.facts.find(
      (fact) =>
        fact.summary.includes("src/bar.ts") && fact.summary.includes("TS2304"),
    );
    expect(foo).not.toBeUndefined();
    expect(bar).not.toBeUndefined();
    expect(foo?.status).toBe("resolved");
    expect(bar?.status).toBe("active");

    const task = runtime.getTaskState(sessionId);
    expect(task.blockers.some((blocker) => blocker.id === bar?.id)).toBe(true);
    expect(task.blockers.some((blocker) => blocker.id === foo?.id)).toBe(false);
  });

  test("stale diagnostic codes resolve when unfiltered output changes", () => {
    const workspace = createWorkspace("truth-from-lsp-diagnostics-stale");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-lsp-diagnostics-3";

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts" },
      outputText: [
        "src/foo.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
        "src/foo.ts(11,5): error TS2304: Cannot find name 'bar'.",
      ].join("\n"),
      success: true,
    });

    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts" },
      outputText:
        "src/foo.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      success: true,
    });

    const truth = runtime.getTruthState(sessionId);
    const ts2322 = truth.facts.find(
      (fact) =>
        fact.summary.includes("src/foo.ts") && fact.summary.includes("TS2322"),
    );
    const ts2304 = truth.facts.find(
      (fact) =>
        fact.summary.includes("src/foo.ts") && fact.summary.includes("TS2304"),
    );

    expect(ts2322).not.toBeUndefined();
    expect(ts2304).not.toBeUndefined();
    expect(ts2322?.status).toBe("active");
    expect(ts2304?.status).toBe("resolved");

    const task = runtime.getTaskState(sessionId);
    expect(task.blockers.some((blocker) => blocker.id === ts2322?.id)).toBe(
      true,
    );
    expect(task.blockers.some((blocker) => blocker.id === ts2304?.id)).toBe(
      false,
    );
  });
});
