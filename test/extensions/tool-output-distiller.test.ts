import { describe, expect, test } from "bun:test";
import { distillToolOutput } from "@brewva/brewva-gateway/runtime-plugins";

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

  test("uses explicit fail verdict for exec summaries even when the channel succeeds", () => {
    const output = Array.from({ length: 120 }, (_value, index) =>
      index % 15 === 0 ? `error: failed at step ${index}` : `trace line ${index}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: false,
      verdict: "fail",
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.summaryText.includes("status: failed")).toBe(true);
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

  test("applies grep heuristic for large bounded grep output", () => {
    const output = [
      "# Grep",
      "- query: TODO",
      "- workdir: /repo",
      "- paths: src",
      "- exit_code: 0",
      "- matches_shown: 200",
      "- truncated: true",
      "- timed_out: false",
      "",
      ...Array.from(
        { length: 200 },
        (_value, index) => `src/file-${Math.floor(index / 20)}.ts:${index + 1}: TODO item ${index}`,
      ),
    ].join("\n");
    const distillation = distillToolOutput({
      toolName: "grep",
      isError: false,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("grep_heuristic");
    expect(distillation.summaryText.includes("[GrepDistilled]")).toBe(true);
    expect(distillation.summaryText.includes("- query: TODO")).toBe(true);
    expect(distillation.summaryText.includes("src/file-0.ts:1: TODO item 0")).toBe(true);
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
