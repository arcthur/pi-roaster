import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Tool failure context injection", () => {
  test("injects recent failure details for self-correction", async () => {
    const workspace = createWorkspace("tool-failures-inject");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-inject-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: test suite failed with 3 failures",
      success: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolFailures]")).toBe(true);
    expect(injection.text.includes("tool=exec")).toBe(true);
    expect(injection.text.includes("bun test")).toBe(true);
    expect(injection.text.includes("3 failures")).toBe(true);
  });

  test("respects maxEntries and maxOutputChars from config", async () => {
    const workspace = createWorkspace("tool-failures-limits");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolFailureInjection.maxEntries = 2;
    config.infrastructure.toolFailureInjection.maxOutputChars = 24;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-limits-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_1",
      args: { value: 1 },
      outputText: "error-one",
      success: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_2",
      args: { value: 2 },
      outputText: "error-two with extra detail",
      success: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_3",
      args: { value: 3 },
      outputText: "error-three with even longer details",
      success: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolFailures]")).toBe(true);
    expect(injection.text.includes("tool=tool_1")).toBe(false);
    expect(injection.text.includes("tool=tool_2")).toBe(true);
    expect(injection.text.includes("tool=tool_3")).toBe(true);
    expect(injection.text.includes("error-three with even")).toBe(true);
    expect(injection.text.includes("...")).toBe(true);
  });

  test("skips failure injection when disabled", async () => {
    const workspace = createWorkspace("tool-failures-disabled");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolFailureInjection.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-disabled-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: fail",
      success: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolFailures]")).toBe(false);
    expect(injection.text.includes("[RecentToolOutputsDistilled]")).toBe(false);
  });

  test("injects recent distilled tool outputs for compressed execution context", async () => {
    const workspace = createWorkspace("tool-output-distilled-inject");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-output-distilled-inject-1";

    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
        summaryText: "[ExecDistilled]\nstatus: failed\n- Error: test suite failed",
        rawTokens: 160,
        summaryTokens: 32,
        compressionRatio: 0.2,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-exec-distill.txt",
        isError: true,
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolOutputsDistilled]")).toBe(true);
    expect(injection.text.includes("tool=exec")).toBe(true);
    expect(injection.text.includes("strategy=exec_heuristic")).toBe(true);
    expect(injection.text.includes("raw_tokens=160")).toBe(true);
    expect(injection.text.includes("summary_tokens=32")).toBe(true);
    expect(injection.text.includes("compression=0.200")).toBe(true);
    expect(
      injection.text.includes(
        "artifact=.orchestrator/tool-output-artifacts/sess/tc-exec-distill.txt",
      ),
    ).toBe(true);
    expect(injection.text.includes("summary: [ExecDistilled] status: failed")).toBe(true);
  });

  test("respects distilled output maxEntries and maxOutputChars from config", async () => {
    const workspace = createWorkspace("tool-output-distilled-limits");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.toolOutputDistillationInjection.maxEntries = 1;
    config.infrastructure.toolOutputDistillationInjection.maxOutputChars = 36;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-output-distilled-limits-1";

    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
        summaryText:
          "[ExecDistilled]\nstatus: failed\n- first summary should be dropped by maxEntries",
        rawTokens: 120,
        summaryTokens: 30,
        compressionRatio: 0.25,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-1.txt",
        isError: true,
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "lsp_diagnostics",
        strategy: "lsp_heuristic",
        summaryText:
          "[LspDistilled] errors=2 warnings=1\n- src/main.ts:12:3 very long summary detail that should be truncated",
        rawTokens: 90,
        summaryTokens: 18,
        compressionRatio: 0.2,
        artifactRef: ".orchestrator/tool-output-artifacts/sess/tc-2.txt",
        isError: false,
      },
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolOutputsDistilled]")).toBe(true);
    expect(injection.text.includes("tool=exec")).toBe(false);
    expect(injection.text.includes("tool=lsp_diagnostics")).toBe(true);
    expect(
      injection.text.includes("artifact=.orchestrator/tool-output-artifacts/sess/tc-2.txt"),
    ).toBe(true);
    expect(injection.text.includes("summary: [LspDistilled] errors=2 warning")).toBe(true);
    expect(injection.text.includes("...")).toBe(true);
  });

  test("persists structured failure context metadata on failed tool results", async () => {
    const workspace = createWorkspace("tool-failures-metadata");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-metadata-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test", retries: 1 },
      outputText: "Error: failing test run",
      success: false,
    });

    const row = runtime.ledger.listRows(sessionId).at(-1);
    const metadata = row?.metadata as
      | {
          brewvaToolFailureContext?: {
            schema?: string;
            args?: Record<string, unknown>;
            outputText?: string;
            failureClass?: string;
          };
        }
      | undefined;
    expect(metadata?.brewvaToolFailureContext?.schema).toBe("brewva.tool_failure_context.v1");
    expect(metadata?.brewvaToolFailureContext?.args?.command).toBe("bun test");
    expect(metadata?.brewvaToolFailureContext?.outputText).toContain("failing test run");
    expect(metadata?.brewvaToolFailureContext?.failureClass).toBe("execution");
  });

  test("reads persisted failure context output beyond ledger outputSummary cap", async () => {
    const workspace = createWorkspace("tool-failures-long-output");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.maxInjectionTokens = 4000;
    config.infrastructure.toolFailureInjection.maxOutputChars = 900;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-long-output-1";
    const outputText = `${"x".repeat(560)}TAIL_MARKER_FROM_PERSISTED_CONTEXT`;

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText,
      success: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolFailures]")).toBe(true);
    expect(injection.text.includes("TAIL_MARKER_FROM_PERSISTED_CONTEXT")).toBe(true);
  });

  test("keeps user failures with brewva_ prefix but skips internal runtime tools", async () => {
    const workspace = createWorkspace("tool-failures-prefix-filter");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-prefix-filter-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "brewva_custom_exec",
      args: { command: "custom-runner" },
      outputText: "Error: user tool failed",
      success: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "brewva_verify",
      args: { check: "typecheck" },
      outputText: "Error: verifier failed",
      success: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolFailures]")).toBe(true);
    expect(injection.text.includes("tool=brewva_custom_exec")).toBe(true);
    expect(injection.text.includes("tool=brewva_verify")).toBe(false);
  });

  test("caps persisted failure args metadata size", async () => {
    const workspace = createWorkspace("tool-failures-large-args");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-large-args-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: {
        command: "bun test",
        payload: "x".repeat(30_000),
        nested: {
          values: Array.from({ length: 400 }, (_, i) => `value-${i}`),
        },
      },
      outputText: "Error: large args payload",
      success: false,
    });

    const row = runtime.ledger.listRows(sessionId).at(-1);
    const metadata = row?.metadata as
      | {
          brewvaToolFailureContext?: {
            args?: Record<string, unknown>;
          };
        }
      | undefined;

    const persistedArgs = metadata?.brewvaToolFailureContext?.args;
    expect(persistedArgs).toBeDefined();
    expect(JSON.stringify(persistedArgs).length).toBeLessThanOrEqual(1400);
  });

  test("does not summarize recent failures into ContextTruncated under practical defaults", async () => {
    const workspace = createWorkspace("tool-failures-budget");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.maxInjectionTokens = 2400;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "tool-failures-budget-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_1",
      args: { command: "one", retries: 1 },
      outputText: `${"x".repeat(240)}TAIL_MARKER_1`,
      success: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_2",
      args: { command: "two", retries: 2 },
      outputText: `${"y".repeat(240)}TAIL_MARKER_2`,
      success: false,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "tool_3",
      args: { command: "three", retries: 3 },
      outputText: `${"z".repeat(240)}TAIL_MARKER_3`,
      success: false,
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue");
    expect(injection.text.includes("[RecentToolFailures]")).toBe(true);
    expect(injection.text.includes("source=brewva.tool-failures")).toBe(false);
    expect(injection.text.includes("TAIL_MARKER_3")).toBe(true);
  });

  test("drops stale failures after 3 tape handoffs", async () => {
    const workspace = createWorkspace("tool-failures-ttl");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tool-failures-ttl-1";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: stale failure",
      success: false,
    });

    const before = await runtime.context.buildInjection(sessionId, "continue");
    expect(before.text.includes("[RecentToolFailures]")).toBe(true);

    runtime.events.recordTapeHandoff(sessionId, { name: "phase-1" });
    runtime.events.recordTapeHandoff(sessionId, { name: "phase-2" });
    runtime.events.recordTapeHandoff(sessionId, { name: "phase-3" });

    const after = await runtime.context.buildInjection(sessionId, "continue");
    expect(after.text.includes("[RecentToolFailures]")).toBe(false);
    expect(after.text.includes("stale failure")).toBe(false);
  });
});
