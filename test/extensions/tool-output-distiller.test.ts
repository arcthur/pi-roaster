import { describe, expect, test } from "bun:test";
import { distillToolOutput } from "@brewva/brewva-extensions";

describe("tool output distiller", () => {
  test("applies exec heuristic and compresses noisy output", () => {
    const output = Array.from({ length: 200 }, (_value, index) =>
      index % 23 === 0 ? `error: failed at step ${index}` : `trace line ${index}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: true,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("exec_heuristic");
    expect(distillation.rawTokens).toBeGreaterThan(distillation.summaryTokens);
    expect(distillation.compressionRatio).toBeLessThan(1);
    expect(distillation.summaryText.includes("[ExecDistilled]")).toBe(true);
  });

  test("applies lsp heuristic for lsp tool family", () => {
    const output = Array.from({ length: 90 }, (_value, index) =>
      index % 9 === 0
        ? `src/main.ts:${index + 1}:3 error TS2339 Property 'x' does not exist on type 'Y'.`
        : `src/main.ts:${index + 1}:1 warning Unused variable z${index}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "lsp_diagnostics",
      isError: true,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("lsp_heuristic");
    expect(distillation.summaryText.includes("[LspDistilled]")).toBe(true);
    expect(distillation.summaryText.includes("src/main.ts:10:3")).toBe(true);
  });

  test("skips low-value distillation when output is too small", () => {
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: false,
      outputText: "status: completed\n- done",
    });

    expect(distillation.distillationApplied).toBe(false);
    expect(distillation.strategy).toBe("none");
    expect(distillation.summaryText).toBe("");
  });

  test("keeps non-target tools as no-op distillation", () => {
    const distillation = distillToolOutput({
      toolName: "edit",
      isError: false,
      outputText: "edited file src/a.ts",
    });

    expect(distillation.distillationApplied).toBe(false);
    expect(distillation.strategy).toBe("none");
    expect(distillation.summaryText).toBe("");
    expect(distillation.summaryTokens).toBe(0);
  });
});
