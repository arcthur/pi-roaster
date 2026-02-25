import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrewvaToolRuntime,
  getToolSessionId,
  readTextBatch,
  recordParallelReadTelemetry,
  resolveAdaptiveBatchSize,
  resolveParallelReadConfig,
  summarizeReadBatch,
} from "@brewva/brewva-tools";

describe("parallel-read utils", () => {
  test("resolveParallelReadConfig handles enabled, disabled, and capped budgets", () => {
    const disabledRuntime = {
      config: { parallel: { enabled: false, maxConcurrent: 8 } },
    } as unknown as BrewvaToolRuntime;
    const disabled = resolveParallelReadConfig(disabledRuntime);
    expect(disabled).toEqual({
      batchSize: 1,
      mode: "sequential",
      reason: "parallel_disabled",
    });

    const enabledRuntime = {
      config: { parallel: { enabled: true, maxConcurrent: 3 } },
    } as unknown as BrewvaToolRuntime;
    const enabled = resolveParallelReadConfig(enabledRuntime);
    expect(enabled).toEqual({
      batchSize: 12,
      mode: "parallel",
      reason: "runtime_parallel_budget",
    });

    const lowBudgetRuntime = {
      config: { parallel: { enabled: true, maxConcurrent: 1 } },
    } as unknown as BrewvaToolRuntime;
    const lowBudget = resolveParallelReadConfig(lowBudgetRuntime);
    expect(lowBudget.batchSize).toBe(4);
    expect(lowBudget.mode).toBe("parallel");
    expect(lowBudget.reason).toBe("runtime_parallel_budget");

    const cappedRuntime = {
      config: { parallel: { enabled: true, maxConcurrent: 1000 } },
    } as unknown as BrewvaToolRuntime;
    const capped = resolveParallelReadConfig(cappedRuntime);
    expect(capped.batchSize).toBe(64);
    expect(capped.mode).toBe("parallel");
    expect(capped.reason).toBe("runtime_parallel_budget");
  });

  test("resolveParallelReadConfig falls back when runtime is unavailable", () => {
    const fallback = resolveParallelReadConfig(undefined);
    expect(fallback).toEqual({
      batchSize: 16,
      mode: "parallel",
      reason: "runtime_unavailable",
    });
  });

  test("getToolSessionId trims and validates context session id", () => {
    expect(getToolSessionId(undefined)).toBeUndefined();
    expect(getToolSessionId({})).toBeUndefined();
    expect(
      getToolSessionId({
        sessionManager: { getSessionId: () => "  session-1  " },
      }),
    ).toBe("session-1");
    expect(
      getToolSessionId({
        sessionManager: { getSessionId: () => "   " },
      }),
    ).toBeUndefined();
    expect(
      getToolSessionId({
        sessionManager: { getSessionId: () => 42 },
      }),
    ).toBeUndefined();
  });

  test("recordParallelReadTelemetry emits only when runtime and session id are available", () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
      events: {
        record(input: Record<string, unknown>) {
          calls.push(input);
          return undefined;
        },
      },
    } as unknown as BrewvaToolRuntime;

    recordParallelReadTelemetry(
      {
        events: undefined,
      } as unknown as BrewvaToolRuntime,
      "session-telemetry",
      {
        toolName: "lsp_symbols",
        operation: "find_references",
        batchSize: 8,
        mode: "parallel",
        reason: "runtime_parallel_budget",
        scannedFiles: 10,
        loadedFiles: 9,
        failedFiles: 1,
        batches: 2,
        durationMs: 20,
      },
    );
    expect(calls).toHaveLength(0);

    recordParallelReadTelemetry(runtime, undefined, {
      toolName: "lsp_symbols",
      operation: "find_references",
      batchSize: 8,
      mode: "parallel",
      reason: "runtime_parallel_budget",
      scannedFiles: 10,
      loadedFiles: 9,
      failedFiles: 1,
      batches: 2,
      durationMs: 20,
    });
    expect(calls).toHaveLength(0);

    recordParallelReadTelemetry(runtime, "session-telemetry", {
      toolName: "lsp_symbols",
      operation: "find_references",
      batchSize: 8,
      mode: "parallel",
      reason: "runtime_parallel_budget",
      scannedFiles: 10,
      loadedFiles: 9,
      failedFiles: 1,
      batches: 2,
      durationMs: 20,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sessionId: "session-telemetry",
      type: "tool_parallel_read",
      payload: {
        toolName: "lsp_symbols",
        operation: "find_references",
        batchSize: 8,
        mode: "parallel",
        reason: "runtime_parallel_budget",
        scannedFiles: 10,
        loadedFiles: 9,
        failedFiles: 1,
        batches: 2,
        durationMs: 20,
      },
    });
  });

  test("resolveAdaptiveBatchSize clamps batch to remaining work", () => {
    expect(resolveAdaptiveBatchSize(12, 99)).toBe(12);
    expect(resolveAdaptiveBatchSize(12, 5)).toBe(5);
    expect(resolveAdaptiveBatchSize(12, 1)).toBe(1);
    expect(resolveAdaptiveBatchSize(0, 0)).toBe(1);
  });

  test("summarizeReadBatch reports scanned/loaded/failed counters", () => {
    const summary = summarizeReadBatch([
      { file: "a.ts", content: "a" },
      { file: "b.ts", content: null },
      { file: "c.ts", content: "c" },
    ]);
    expect(summary).toEqual({
      scannedFiles: 3,
      loadedFiles: 2,
      failedFiles: 1,
    });
  });

  test("readTextBatch preserves input order and marks unreadable files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "parallel-read-utils-"));
    const fileA = join(workspace, "a.ts");
    const fileB = join(workspace, "b.ts");
    const missing = join(workspace, "missing.ts");
    writeFileSync(fileA, "export const a = 1;\n", "utf8");
    writeFileSync(fileB, "export const b = 2;\n", "utf8");

    const loaded = await readTextBatch([fileB, missing, fileA]);
    expect(loaded).toHaveLength(3);
    expect(loaded[0]).toEqual({ file: fileB, content: "export const b = 2;\n" });
    expect(loaded[1]).toEqual({ file: missing, content: null });
    expect(loaded[2]).toEqual({ file: fileA, content: "export const a = 1;\n" });
  });
});
