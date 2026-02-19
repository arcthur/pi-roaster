import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  createAstGrepTools,
  createLspTools,
} from "@brewva/brewva-tools";
import { resolveParallelReadConfig } from "../../packages/brewva-tools/src/utils/parallel-read.js";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find((item) => item.type === "text" && typeof item.text === "string");
  return textPart?.text ?? "";
}

function fakeContext(sessionId: string, cwd: string): any {
  return {
    cwd,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function workspaceWithSampleFiles(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/a.ts"), "export const valueA = 1;\nexport const valueAX = valueA + 2;\n", "utf8");
  writeFileSync(join(workspace, "src/b.ts"), "import { valueA } from './a';\nexport const valueB = valueA + 1;\n", "utf8");
  writeFileSync(join(workspace, "src/c.ts"), "export const valueC = 3;\n", "utf8");
  return workspace;
}

function getParallelReadPayloads(runtime: BrewvaRuntime, sessionId: string): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];
  for (const event of runtime.queryEvents(sessionId, { type: "tool_parallel_read" })) {
    if (!event.payload) continue;
    payloads.push(event.payload as unknown as Record<string, unknown>);
  }
  return payloads;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function expectTelemetryCountersConsistent(payload: Record<string, unknown>): void {
  const scannedFiles = toFiniteNumber(payload.scannedFiles);
  const loadedFiles = toFiniteNumber(payload.loadedFiles);
  const failedFiles = toFiniteNumber(payload.failedFiles);
  expect(scannedFiles).toBe(loadedFiles + failedFiles);
}

describe("tool parallel read runtime integration", () => {
  test("buildBrewvaTools wires runtime-aware lsp scans for telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-build-runtime-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-build-runtime";
    const tools = buildBrewvaTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-build-lsp-symbols",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_symbols",
    );
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.operation === "find_references")).toBe(
      true,
    );
  });

  test("lsp workspace scan emits parallel telemetry when runtime parallel is enabled", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-parallel-enabled-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-enabled";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-enabled",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length > 0).toBe(true);

    const events = runtime.queryEvents(sessionId, { type: "tool_parallel_read" });
    const telemetry = events.find((event) => event.payload?.toolName === "lsp_symbols")?.payload;
    expect(telemetry).toBeDefined();
    expect(telemetry?.mode).toBe("parallel");
    expect(typeof telemetry?.batchSize).toBe("number");
    expect((telemetry?.batchSize as number) > 1).toBe(true);
    expect(telemetry?.reason).toBe("runtime_parallel_budget");
    expect(typeof telemetry?.scannedFiles).toBe("number");
    expect(typeof telemetry?.loadedFiles).toBe("number");
    expect(typeof telemetry?.failedFiles).toBe("number");
    expect(typeof telemetry?.durationMs).toBe("number");
    if (telemetry) {
      expectTelemetryCountersConsistent(
        telemetry as unknown as Record<string, unknown>,
      );
    }
  });

  test("lsp workspace scan emits sequential telemetry when runtime parallel is disabled", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-parallel-disabled-");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.parallel.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "parallel-read-disabled";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-disabled",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const events = runtime.queryEvents(sessionId, { type: "tool_parallel_read" });
    const telemetry = events.find((event) => event.payload?.toolName === "lsp_symbols")?.payload;
    expect(telemetry).toBeDefined();
    expect(telemetry?.mode).toBe("sequential");
    expect(telemetry?.batchSize).toBe(1);
    expect(telemetry?.reason).toBe("parallel_disabled");
    if (telemetry) {
      expectTelemetryCountersConsistent(
        telemetry as unknown as Record<string, unknown>,
      );
    }
  });

  test("lsp workspace low-limit scan avoids eager over-read", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-low-limit-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-low-limit";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-low-limit",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "export",
        limit: 1,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("export")).toBe(true);

    const events = runtime.queryEvents(sessionId, { type: "tool_parallel_read" });
    const telemetry = events.find((event) => event.payload?.toolName === "lsp_symbols")?.payload;
    expect(telemetry).toBeDefined();
    expect(telemetry?.scannedFiles).toBe(1);
    expect(telemetry?.loadedFiles).toBe(1);
    expect(telemetry?.failedFiles).toBe(0);
    if (telemetry) {
      expectTelemetryCountersConsistent(
        telemetry as unknown as Record<string, unknown>,
      );
    }
  });

  test("lsp_find_references with includeDeclaration=false emits both reference and definition scans", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-findrefs-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-findrefs";
    const tools = createLspTools({ runtime });
    const lspFindReferences = tools.find((tool) => tool.name === "lsp_find_references");
    expect(lspFindReferences).toBeDefined();

    const result = await lspFindReferences!.execute(
      "tc-lsp-findrefs",
      {
        filePath: join(workspace, "src/a.ts"),
        line: 1,
        character: 14,
        includeDeclaration: false,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("valueA")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "lsp_find_references");
    const operations = new Set(payloads.map((payload) => String(payload.operation)));
    expect(operations.has("find_references")).toBe(true);
    expect(operations.has("find_definition")).toBe(true);
  });

  test("lsp_goto_definition emits definition scan telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-goto-def-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-goto-definition";
    const tools = createLspTools({ runtime });
    const lspGotoDefinition = tools.find((tool) => tool.name === "lsp_goto_definition");
    expect(lspGotoDefinition).toBeDefined();

    const result = await lspGotoDefinition!.execute(
      "tc-lsp-goto-definition",
      {
        filePath: join(workspace, "src/a.ts"),
        line: 1,
        character: 14,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("valueA")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "lsp_goto_definition");
    expect(payloads.some((payload) => payload.operation === "find_definition")).toBe(true);

    const definitionTelemetry = payloads.find((payload) => payload.operation === "find_definition");
    expect(definitionTelemetry).toBeDefined();
    if (definitionTelemetry) {
      expect(definitionTelemetry.scannedFiles).toBe(1);
      expect(definitionTelemetry.loadedFiles).toBe(1);
      expect(definitionTelemetry.failedFiles).toBe(0);
      expectTelemetryCountersConsistent(definitionTelemetry);
    }
  });

  test("lsp_prepare_rename emits both reference and definition scan telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-prepare-rename-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-prepare-rename";
    const tools = createLspTools({ runtime });
    const lspPrepareRename = tools.find((tool) => tool.name === "lsp_prepare_rename");
    expect(lspPrepareRename).toBeDefined();

    const result = await lspPrepareRename!.execute(
      "tc-lsp-prepare-rename",
      {
        filePath: join(workspace, "src/b.ts"),
        line: 2,
        character: 23,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("Rename available")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "lsp_prepare_rename");
    const operations = new Set(payloads.map((payload) => String(payload.operation)));
    expect(operations.has("find_references")).toBe(true);
    expect(operations.has("find_definition")).toBe(true);
  });

  test("lsp_symbols in document scope does not emit parallel telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-doc-scope-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-doc-scope";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-document",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "document",
        limit: 20,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("valueA")).toBe(true);
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
  });

  test("parallel batch size is capped for very high runtime maxConcurrent", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-batch-cap-");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.parallel.enabled = true;
    config.parallel.maxConcurrent = 1000;
    config.parallel.maxTotal = 1000;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "parallel-read-batch-cap";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-batch-cap",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "value",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "lsp_symbols");
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.batchSize === 64)).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("does not emit telemetry when session id is unavailable in tool context", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-no-session-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-no-session",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext("", workspace),
    );

    expect(runtime.queryEvents("parallel-read-no-session", { type: "tool_parallel_read" })).toHaveLength(0);
  });

  test("counts failed files in telemetry when some files are unreadable", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-read-failures-");
    const unreadable = join(workspace, "src/unreadable.ts");
    writeFileSync(unreadable, "export const unreadableValue = 7;\n", "utf8");
    chmodSync(unreadable, 0o000);

    try {
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionId = "parallel-read-failures";
      const tools = createLspTools({ runtime });
      const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
      expect(lspSymbols).toBeDefined();

      await lspSymbols!.execute(
        "tc-lsp-symbols-read-failures",
        {
          filePath: join(workspace, "src/a.ts"),
          scope: "workspace",
          query: "value",
        },
        undefined,
        undefined,
        fakeContext(sessionId, workspace),
      );

      const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "lsp_symbols");
      expect(payloads.length > 0).toBe(true);
      const failedFiles = Number(payloads[0]?.failedFiles ?? 0);
      expect(Number.isFinite(failedFiles)).toBe(true);
      if (payloads[0]) {
        expectTelemetryCountersConsistent(payloads[0]);
      }
      if (process.platform !== "win32") {
        expect(failedFiles >= 1).toBe(true);
      }
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });

  test("lsp workspace scan tolerates invalid cwd that points to a file", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-invalid-cwd-file-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-invalid-cwd-file";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const fileCwd = join(workspace, "src/a.ts");
    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-invalid-cwd-file",
      {
        filePath: fileCwd,
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, fileCwd),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toBe("No symbols found");
    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "lsp_symbols");
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.scannedFiles === 0)).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("ast_grep_search fallback tolerates invalid cwd that points to a file", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-file-cwd-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-astgrep-file-cwd";
    const tools = createAstGrepTools({ runtime });
    const astGrepSearch = tools.find((tool) => tool.name === "ast_grep_search");
    expect(astGrepSearch).toBeDefined();

    const fileCwd = join(workspace, "src/a.ts");
    const result = await astGrepSearch!.execute(
      "tc-astgrep-search-file-cwd",
      {
        pattern: "valueA",
        lang: "ts",
      },
      undefined,
      undefined,
      fakeContext(sessionId, fileCwd),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("No matches found")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "ast_grep_search");
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.operation === "naive_search")).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("ast_grep_search fallback avoids eager over-read when first file saturates limit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-astgrep-saturate-"));
    const hitRoot = join(workspace, "hit");
    const tailRoot = join(workspace, "tail");
    mkdirSync(hitRoot, { recursive: true });
    mkdirSync(tailRoot, { recursive: true });

    const saturated = Array.from({ length: 250 }, (_, index) => `const fallbackToken = ${index};`).join("\n") + "\n";
    writeFileSync(join(hitRoot, "hit.ts"), saturated, "utf8");
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(tailRoot, `tail-${i}.ts`), `const tailToken${i} = ${i};\n`, "utf8");
    }

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-astgrep-saturate";
    const tools = createAstGrepTools({ runtime });
    const astGrepSearch = tools.find((tool) => tool.name === "ast_grep_search");
    expect(astGrepSearch).toBeDefined();

    const invalidCwd = join(workspace, "missing-cwd");
    const result = await astGrepSearch!.execute(
      "tc-astgrep-search-saturate",
      {
        pattern: "fallbackToken",
        lang: "ts",
        paths: [hitRoot, tailRoot],
      },
      undefined,
      undefined,
      fakeContext(sessionId, invalidCwd),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("hit.ts")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "ast_grep_search");
    expect(payloads.length > 0).toBe(true);
    const telemetry = payloads.find((payload) => payload.operation === "naive_search");
    expect(telemetry).toBeDefined();
    expect(telemetry?.scannedFiles).toBe(1);
    expect(telemetry?.loadedFiles).toBe(1);
    expect(telemetry?.failedFiles).toBe(0);
    if (telemetry) {
      expectTelemetryCountersConsistent(telemetry);
    }
  });

  test("ast_grep_search fallback emits runtime telemetry when command execution fails", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-search-fallback-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-astgrep-search-fallback";
    const tools = createAstGrepTools({ runtime });
    const astGrepSearch = tools.find((tool) => tool.name === "ast_grep_search");
    expect(astGrepSearch).toBeDefined();

    const invalidCwd = join(workspace, "missing-cwd");
    const result = await astGrepSearch!.execute(
      "tc-astgrep-search-fallback",
      {
        pattern: "valueA",
        lang: "ts",
      },
      undefined,
      undefined,
      fakeContext(sessionId, invalidCwd),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("No matches found")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "ast_grep_search");
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.operation === "naive_search")).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("ast_grep_replace fallback emits runtime telemetry when command execution fails", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-replace-fallback-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-astgrep-replace-fallback";
    const tools = createAstGrepTools({ runtime });
    const astGrepReplace = tools.find((tool) => tool.name === "ast_grep_replace");
    expect(astGrepReplace).toBeDefined();

    const invalidCwd = join(workspace, "missing-cwd");
    const result = await astGrepReplace!.execute(
      "tc-astgrep-replace-fallback",
      {
        pattern: "valueA",
        rewrite: "valueA2",
        lang: "ts",
        dryRun: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId, invalidCwd),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("No matches found")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "ast_grep_replace");
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.operation === "naive_replace")).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("ast_grep_replace fallback non-dry-run applies updates and records consistent telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-astgrep-replace-apply-");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "parallel-read-astgrep-replace-apply";
    const tools = createAstGrepTools({ runtime });
    const astGrepReplace = tools.find((tool) => tool.name === "ast_grep_replace");
    expect(astGrepReplace).toBeDefined();

    const invalidCwd = join(workspace, "missing-cwd");
    const targetFile = join(workspace, "src/a.ts");
    const result = await astGrepReplace!.execute(
      "tc-astgrep-replace-apply",
      {
        pattern: "valueA",
        rewrite: "valueAUpdated",
        lang: "ts",
        dryRun: false,
        paths: [join(workspace, "src")],
      },
      undefined,
      undefined,
      fakeContext(sessionId, invalidCwd),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("Applied updates")).toBe(true);

    const rewritten = readFileSync(targetFile, "utf8");
    expect(rewritten.includes("valueAUpdated")).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter((payload) => payload.toolName === "ast_grep_replace");
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.operation === "naive_replace")).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("resolveParallelReadConfig falls back to runtime_unavailable defaults", () => {
    const config = resolveParallelReadConfig(undefined);
    expect(config.reason).toBe("runtime_unavailable");
    expect(config.mode).toBe("parallel");
    expect(config.batchSize).toBe(16);
  });
});
