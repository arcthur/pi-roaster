import { describe, expect, test } from "bun:test";
import { registerRuntimeCoreBridge } from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler } from "../helpers/extension.js";

interface RuntimeCalls {
  started: Array<Record<string, unknown>>;
  finished: Array<Record<string, unknown>>;
  compacted: Array<{ sessionId: string; input: Record<string, unknown> }>;
  events: Array<Record<string, unknown>>;
  cleared: string[];
  observedContext: Array<{ sessionId: string; usage: unknown }>;
}

function createRuntimeFixture(
  input: {
    startAllowed?: boolean;
    startReason?: string;
  } = {},
): { runtime: Record<string, unknown>; calls: RuntimeCalls } {
  const calls: RuntimeCalls = {
    started: [],
    finished: [],
    compacted: [],
    events: [],
    cleared: [],
    observedContext: [],
  };

  const runtime = {
    tools: {
      start(payload: Record<string, unknown>) {
        calls.started.push(payload);
        return {
          allowed: input.startAllowed ?? true,
          reason: input.startReason,
        };
      },
      finish(payload: Record<string, unknown>) {
        calls.finished.push(payload);
      },
    },
    context: {
      markCompacted(sessionId: string, payload: Record<string, unknown>) {
        calls.compacted.push({ sessionId, input: payload });
      },
      observeUsage(sessionId: string, usage: unknown) {
        calls.observedContext.push({ sessionId, usage });
      },
      getCompactionGateStatus() {
        return {
          required: true,
          pressure: { level: "critical", usageRatio: 0.97, hardLimitRatio: 0.98 },
          recentCompaction: false,
          windowTurns: 2,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        };
      },
      getCompactionThresholdRatio() {
        return 0.8;
      },
      getHardLimitRatio() {
        return 0.98;
      },
      sanitizeInput(text: string) {
        return text;
      },
    },
    events: {
      record(payload: Record<string, unknown>) {
        calls.events.push(payload);
      },
      getTapeStatus() {
        return {
          tapePressure: "medium",
          totalEntries: 42,
          entriesSinceAnchor: 7,
          entriesSinceCheckpoint: 4,
          lastAnchor: { id: "anchor-1", name: "phase-alpha" },
          thresholds: { low: 5, medium: 20, high: 50 },
        };
      },
      getTapePressureThresholds() {
        return { low: 5, medium: 20, high: 50 };
      },
    },
    session: {
      clearState(sessionId: string) {
        calls.cleared.push(sessionId);
      },
    },
    config: {
      tape: {
        tapePressureThresholds: { low: 5, medium: 20, high: 50 },
      },
    },
  };

  return { runtime, calls };
}

function createSessionContext(sessionId: string): {
  sessionManager: { getSessionId: () => string };
  getContextUsage: () => { tokens: number; contextWindow: number; percent: number };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    getContextUsage: () => ({ tokens: 320, contextWindow: 4096, percent: 0.078 }),
  };
}

describe("runtime core bridge extension", () => {
  test("given core bridge registration, when extension initializes, then required hooks are subscribed", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime as any);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  test("given before_agent_start, when bridge handles context, then prompt is annotated with core contract", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime as any);

    const beforeStart = invokeHandler<{
      systemPrompt?: string;
      message?: { content?: string; details?: Record<string, unknown> };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue task",
        systemPrompt: "base prompt",
      },
      createSessionContext("core-before-start"),
    );
    expect(beforeStart.systemPrompt?.includes("[Brewva Core Context Contract]")).toBe(true);
    expect(beforeStart.message?.content?.includes("[CoreTapeStatus]")).toBe(true);
    expect(beforeStart.message?.content?.includes("required_action: session_compact_now")).toBe(
      true,
    );
    expect(beforeStart.message?.details?.profile).toBe("runtime-core");
    expect(calls.observedContext).toHaveLength(1);
    expect(calls.observedContext[0]?.sessionId).toBe("core-before-start");
  });

  test("given tool_call event, when bridge handles it, then runtime.tools.start is invoked", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime as any);

    const toolCallResult = invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-1",
        toolName: "exec",
        input: { command: "echo ok" },
      },
      createSessionContext("core-tool-call"),
    );
    expect(toolCallResult).toBeUndefined();
    expect(calls.started).toHaveLength(1);
    expect(calls.started[0]?.sessionId).toBe("core-tool-call");
    expect(calls.started[0]?.toolName).toBe("exec");
  });

  test("given tool_result event, when bridge handles it, then runtime.tools.finish is invoked", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime as any);
    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-1",
        toolName: "exec",
        input: { command: "echo ok" },
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: { durationMs: 1 },
      },
      createSessionContext("core-tool-result"),
    );
    expect(calls.finished).toHaveLength(1);
    expect(calls.finished[0]?.sessionId).toBe("core-tool-result");
    expect(calls.finished[0]?.toolCallId).toBe("tc-1");
    expect(calls.finished[0]?.success).toBe(true);
  });

  test("given session_compact event, when bridge handles it, then compaction is marked and event recorded", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime as any);
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-1",
          summary: "compact summary",
        },
        fromExtension: false,
      },
      createSessionContext("core-compact"),
    );
    expect(calls.compacted).toHaveLength(1);
    expect(calls.compacted[0]?.sessionId).toBe("core-compact");
    expect(calls.events.some((event) => event.type === "session_compact")).toBe(true);
  });

  test("given session_shutdown event, when bridge handles it, then runtime session state is cleared", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime as any);
    invokeHandler(handlers, "session_shutdown", {}, createSessionContext("core-shutdown"));
    expect(calls.cleared).toEqual(["core-shutdown"]);
  });

  test("given runtime.tools.start denied result, when handling tool_call, then bridge returns block response", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime } = createRuntimeFixture({
      startAllowed: false,
      startReason: "blocked",
    });
    registerRuntimeCoreBridge(api, runtime as any);

    const result = invokeHandler<{ block?: boolean; reason?: string }>(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-block",
        toolName: "exec",
        input: { command: "false" },
      },
      {
        sessionManager: { getSessionId: () => "core-2" },
        getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toBe("blocked");
  });
});
