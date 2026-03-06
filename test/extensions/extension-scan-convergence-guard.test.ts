import { describe, expect, test } from "bun:test";
import {
  registerEventStream,
  registerQualityGate,
  registerScanConvergenceGuard,
} from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler, invokeHandlers } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createContext(sessionId: string, cwd = "/tmp/brewva-scan-guard") {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

function markToolExecuted(
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >,
  ctx: Record<string, unknown>,
  toolCallId: string,
  toolName: string,
): void {
  invokeHandlers(handlers, "tool_execution_start", { toolCallId, toolName }, ctx);
}

function markToolExecutionEnded(
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >,
  ctx: Record<string, unknown>,
  input: {
    toolCallId: string;
    toolName: string;
    isError?: boolean;
    result?: Record<string, unknown>;
  },
): void {
  invokeHandlers(
    handlers,
    "tool_execution_end",
    {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      isError: input.isError === true,
      result: input.result,
    },
    ctx,
  );
}

function runTurn(params: {
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >;
  ctx: Record<string, unknown>;
  turnIndex: number;
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
}): void {
  invokeHandlers(
    params.handlers,
    "tool_call",
    {
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      input: params.input,
    },
    params.ctx,
    { stopOnBlock: true },
  );
  markToolExecuted(params.handlers, params.ctx, params.toolCallId, params.toolName);
  invokeHandlers(
    params.handlers,
    "turn_end",
    {
      turnIndex: params.turnIndex,
      message: { role: "assistant", content: [] },
      toolResults: [],
    },
    params.ctx,
  );
}

describe("Extension gaps: scan convergence guard", () => {
  test("given repeated scan-only turns, when another low-signal tool is attempted, then guard stays armed and records a task blocker", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-turns-1";
    const { api, handlers } = createMockExtensionAPI();

    registerEventStream(api, runtime);
    registerScanConvergenceGuard(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/file-${turnIndex}.ts` },
      });
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_only_turns");

    const blocker = runtime.task
      .getState(sessionId)
      .blockers.find((entry) => entry.id === "guard:scan-convergence");
    expect(blocker?.source).toBe("scan_convergence_guard");
    expect(blocker?.message.includes("preferred_tools=task_add_item,task_record_blocker")).toBe(
      true,
    );

    invokeHandlers(handlers, "turn_start", { turnIndex: 4, timestamp: 4 }, ctx);
    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-look-at-blocked",
        toolName: "look_at",
        input: { goal: "find the session bootstrap" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);

    invokeHandlers(
      handlers,
      "turn_end",
      {
        turnIndex: 4,
        message: { role: "assistant", content: [] },
        toolResults: [],
      },
      ctx,
    );

    expect(runtime.events.query(sessionId, { type: "scan_convergence_reset" })).toHaveLength(0);

    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.toolStrategy).toBe("low_signal");
  });

  test("given repeated out-of-bounds read failures, when another read is attempted, then guard blocks with scan failure reason", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-oob-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let index = 1; index <= 3; index += 1) {
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-read-oob-${index}`,
          toolName: "read",
          input: { file_path: "src/data.ts", offset: 1000 },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-read-oob-${index}`, "read");
      invokeHandler(
        handlers,
        "tool_result",
        {
          toolCallId: `tc-read-oob-${index}`,
          toolName: "read",
          isError: true,
          content: [
            {
              type: "text",
              text: "Offset 1000 is beyond end of file (12 lines total)",
            },
          ],
        },
        ctx,
      );
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_failures");

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-oob-blocked",
        toolName: "read",
        input: { file_path: "src/data.ts", offset: 1001 },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.reason).toBe("scan_failures");
  });

  test("given repeated grep ENOENT failures, when another grep is attempted, then guard blocks", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-grep-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let index = 1; index <= 3; index += 1) {
      invokeHandlers(
        handlers,
        "tool_call",
        {
          toolCallId: `tc-grep-${index}`,
          toolName: "grep",
          input: { pattern: "needle", path: `missing-${index}` },
        },
        ctx,
        { stopOnBlock: true },
      );
      markToolExecuted(handlers, ctx, `tc-grep-${index}`, "grep");
      invokeHandler(
        handlers,
        "tool_result",
        {
          toolCallId: `tc-grep-${index}`,
          toolName: "grep",
          isError: true,
          content: [
            {
              type: "text",
              text: "grep failed: ENOENT: no such file or directory, scandir 'missing-dir'",
            },
          ],
        },
        ctx,
      );
    }

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-grep-blocked",
        toolName: "grep",
        input: { pattern: "needle", path: "missing-dir" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "scan_convergence_blocked_tool", last: 1 }),
    ).toHaveLength(1);
  });

  test("given repeated low-signal investigation turns, when another lookup tool is attempted, then investigation-only guard blocks", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-investigation-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 6; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-look-at-${turnIndex}`,
        toolName: "look_at",
        input: { goal: "find the runtime facade" },
      });
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("investigation_only_turns");

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-lsp-blocked",
        toolName: "lsp_symbols",
        input: { scope: "workspace", query: "BrewvaRuntime" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.reason).toBe("investigation_only_turns");
  });

  test("given an armed guard, when an evidence-reuse tool executes, then the guard resets and scan tools are allowed again", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-reset-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-reset-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/reset-${turnIndex}.ts` },
      });
    }

    const evidenceReuse = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-output-search",
        toolName: "output_search",
        input: { query: "BrewvaRuntime" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(evidenceReuse.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      false,
    );
    markToolExecuted(handlers, ctx, "tc-output-search", "output_search");
    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-output-search",
        toolName: "output_search",
        input: { query: "BrewvaRuntime" },
        isError: false,
        content: [{ type: "text", text: "artifact search complete" }],
      },
      ctx,
    );

    const reset = runtime.events.query(sessionId, { type: "scan_convergence_reset", last: 1 })[0];
    expect(reset?.payload?.reason).toBe("strategy_shift");
    expect(reset?.payload?.toolStrategy).toBe("evidence_reuse");
    expect(runtime.task.getState(sessionId).blockers).toHaveLength(0);

    const readAfterReset = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-after-reset",
        toolName: "read",
        input: { file_path: "src/after-reset.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(readAfterReset.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      false,
    );
  });

  test("given an armed guard, when a strategy-shift tool fails, then the guard stays armed", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-failed-reset-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-failed-reset-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/failed-reset-${turnIndex}.ts` },
      });
    }

    const evidenceReuse = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-output-search-failed",
        toolName: "output_search",
        input: { query: "BrewvaRuntime" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(evidenceReuse.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      false,
    );
    markToolExecuted(handlers, ctx, "tc-output-search-failed", "output_search");
    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-output-search-failed",
        toolName: "output_search",
        input: { query: "BrewvaRuntime" },
        isError: true,
        content: [{ type: "text", text: "artifact lookup failed" }],
      },
      ctx,
    );

    expect(runtime.events.query(sessionId, { type: "scan_convergence_reset" })).toHaveLength(0);
    expect(runtime.task.getState(sessionId).blockers).toHaveLength(1);

    const blockedRead = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-still-armed",
        toolName: "read",
        input: { file_path: "src/still-armed.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(blockedRead.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      true,
    );
  });

  test("given an armed guard, when a low-signal exec command is attempted, then the guard still blocks it", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-exec-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-exec-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/exec-${turnIndex}.ts` },
      });
    }

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-exec-blocked",
        toolName: "exec",
        input: { command: "sh -lc 'ls -la src | head -n 5'" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);
    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.toolStrategy).toBe("low_signal");
  });

  test("given repeated fallback exec lifecycles without tool_call, when the command stays low-signal, then investigation-only guard still arms", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-exec-fallback-turns-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 6; turnIndex += 1) {
      invokeHandlers(
        handlers,
        "tool_execution_start",
        {
          toolCallId: `tc-exec-fallback-${turnIndex}`,
          toolName: "exec",
          args: { command: "sh -lc 'ls -la src | head -n 5'" },
        },
        ctx,
      );
      invokeHandlers(
        handlers,
        "turn_end",
        {
          turnIndex,
          message: { role: "assistant", content: [] },
          toolResults: [],
        },
        ctx,
      );
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("investigation_only_turns");
  });

  test("given an armed guard, when a fallback exec lifecycle starts without tool_call, then low-signal classification does not reset the guard", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-exec-fallback-armed-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-fallback-armed-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/fallback-armed-${turnIndex}.ts` },
      });
    }

    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "tc-exec-fallback-armed",
        toolName: "exec",
        args: { command: "sh -lc 'ls -la src | head -n 5'" },
      },
      ctx,
    );

    expect(runtime.events.query(sessionId, { type: "scan_convergence_reset" })).toHaveLength(0);

    const blockedRead = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-after-fallback",
        toolName: "read",
        input: { file_path: "src/after-fallback.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(blockedRead.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      true,
    );
  });

  test("given a successful execution_end fallback for a strategy-shift tool, when tool_result is missing, then the guard still resets", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-execution-end-reset-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-end-reset-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/end-reset-${turnIndex}.ts` },
      });
    }

    markToolExecuted(handlers, ctx, "tc-task-view-state", "task_view_state");
    markToolExecutionEnded(handlers, ctx, {
      toolCallId: "tc-task-view-state",
      toolName: "task_view_state",
      isError: false,
      result: { content: [{ type: "text", text: "status.phase=blocked" }] },
    });

    const reset = runtime.events.query(sessionId, { type: "scan_convergence_reset", last: 1 })[0];
    expect(reset?.payload?.reason).toBe("strategy_shift");
    expect(reset?.payload?.toolStrategy).toBe("evidence_reuse");
    expect(runtime.task.getState(sessionId).blockers).toHaveLength(0);
  });

  test("given armed guard, when a strategy-shift attempt is blocked later in the handler chain, then the guard remains armed", () => {
    const runtime = createRuntimeFixture({
      tools: {
        start: ({ toolName }: { toolName?: unknown }) =>
          toolName === "task_set_spec"
            ? { allowed: false, reason: "blocked-for-test" }
            : { allowed: true },
      },
    });
    const sessionId = "scan-guard-blocked-non-scan-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-armed-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/armed-${turnIndex}.ts` },
      });
    }

    const armed = runtime.events.query(sessionId, { type: "scan_convergence_armed", last: 1 })[0];
    expect(armed?.payload?.reason).toBe("scan_only_turns");

    invokeHandlers(handlers, "turn_start", { turnIndex: 4, timestamp: 4 }, ctx);

    const blockedNonScan = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-task-set-spec-blocked",
        toolName: "task_set_spec",
        input: { goal: "summarize findings" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blockedNonScan.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      true,
    );
    expect(runtime.events.query(sessionId, { type: "scan_convergence_reset" })).toHaveLength(0);

    const blockedRead = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-read-still-blocked",
        toolName: "read",
        input: { file_path: "src/still-blocked.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(blockedRead.some((result) => (result as { block?: boolean })?.block === true)).toBe(
      true,
    );
  });

  test("given a new user input, when the previous session was armed, then the blocker is cleared and the next scan starts fresh", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "scan-guard-input-reset-1";
    const { api, handlers } = createMockExtensionAPI();

    registerScanConvergenceGuard(api, runtime);

    const ctx = createContext(sessionId, runtime.cwd);

    for (let index = 1; index <= 3; index += 1) {
      runTurn({
        handlers,
        ctx,
        turnIndex: index,
        toolCallId: `tc-input-reset-${index}`,
        toolName: "read",
        input: { file_path: "src/input-reset.ts" },
      });
    }

    expect(runtime.task.getState(sessionId).blockers).toHaveLength(1);

    invokeHandler(
      handlers,
      "input",
      {
        source: "user",
        text: "check a different file",
        images: [],
      },
      ctx,
    );

    expect(runtime.task.getState(sessionId).blockers).toHaveLength(0);

    const freshRead = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-input-reset-fresh",
        toolName: "read",
        input: { file_path: "src/fresh.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(freshRead.some((result) => (result as { block?: boolean })?.block === true)).toBe(false);
  });
});
