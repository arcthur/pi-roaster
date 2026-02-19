import { describe, expect, test } from "bun:test";
import { extractEvidenceArtifacts } from "@brewva/brewva-runtime";

describe("Evidence artifact extraction", () => {
  test("extracts command_failure artifacts from bash output", () => {
    const outputText = [
      "FAIL src/foo.test.ts",
      "AssertionError: expected 1 to be 2",
      "    at Object.<anonymous> (/repo/src/foo.test.ts:12:7)",
      "    at runTest (/repo/node_modules/vitest/dist/index.js:1:1)",
      "",
      "Expected: 2",
      "Received: 1",
    ].join("\n");

    const artifacts = extractEvidenceArtifacts({
      toolName: "bash",
      args: { command: "bun test" },
      outputText,
      isError: true,
      details: { result: { exitCode: 1 } },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind: string;
      command?: unknown;
      exitCode?: unknown;
      failingTests?: unknown;
      failedAssertions?: unknown;
      stackTrace?: unknown;
    };
    expect(artifact.kind).toBe("command_failure");
    expect(artifact.command).toBe("bun test");
    expect(artifact.exitCode).toBe(1);
    expect(Array.isArray(artifact.failingTests)).toBe(true);
    expect(Array.isArray(artifact.failedAssertions)).toBe(true);
    expect(Array.isArray(artifact.stackTrace)).toBe(true);
  });

  test("extracts tsc_diagnostics artifacts from lsp_diagnostics output", () => {
    const outputText = [
      "src/foo.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "src/foo.ts(11,5): error TS2304: Cannot find name 'bar'.",
    ].join("\n");

    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText,
      isError: false,
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind: string;
      tool?: unknown;
      filePath?: unknown;
      severityFilter?: unknown;
      count?: unknown;
      codes?: unknown;
      countsByCode?: unknown;
      diagnostics?: unknown;
    };
    expect(artifact.kind).toBe("tsc_diagnostics");
    expect(artifact.tool).toBe("lsp_diagnostics");
    expect(artifact.filePath).toBe("src/foo.ts");
    expect(artifact.severityFilter).toBe("all");
    expect(artifact.count).toBe(2);
    expect(Array.isArray(artifact.codes)).toBe(true);
    expect(typeof artifact.countsByCode).toBe("object");
    expect(Array.isArray(artifact.diagnostics)).toBe(true);
  });

  test("extracts tsc_diagnostics artifacts from lsp_diagnostics structured details", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText: "unparseable output",
      isError: false,
      details: {
        diagnosticsCount: 2,
        truncated: false,
        countsByCode: {
          TS2322: 1,
          TS2304: 1,
        },
        diagnostics: [
          {
            file: "src/foo.ts",
            line: 10,
            column: 5,
            severity: "error",
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'string'.",
          },
          {
            file: "src/foo.ts",
            line: 11,
            column: 5,
            severity: "error",
            code: "TS2304",
            message: "Cannot find name 'bar'.",
          },
        ],
      },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind: string;
      count?: unknown;
      countsByCode?: unknown;
      diagnostics?: unknown;
    };
    expect(artifact.kind).toBe("tsc_diagnostics");
    expect(artifact.count).toBe(2);
    expect(artifact.countsByCode).toEqual({ TS2322: 1, TS2304: 1 });
    expect(Array.isArray(artifact.diagnostics)).toBe(true);
  });

  test("does not extract diagnostics artifacts when output is clean", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText: "No diagnostics found",
      isError: false,
    });

    expect(artifacts.length).toBe(0);
  });
});
