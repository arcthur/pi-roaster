import { describe, expect, test } from "bun:test";
import { registerRuntimeCoreBridge } from "@brewva/brewva-extensions";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Handler = (event: any, ctx: any) => unknown;

function createMockExtensionAPI(): { api: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function invokeHandler<T = unknown>(
  handlers: Map<string, Handler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): T {
  const list = handlers.get(eventName) ?? [];
  const handler = list[0];
  if (!handler) {
    throw new Error(`Missing handler for event: ${eventName}`);
  }
  return handler(event, ctx) as T;
}

describe("runtime core bridge extension", () => {
  test("wires quality/ledger/compact/shutdown hooks for no-extensions profile", () => {
    const { api, handlers } = createMockExtensionAPI();
    const calls = {
      started: [] as any[],
      finished: [] as any[],
      compacted: [] as any[],
      events: [] as any[],
      cleared: [] as string[],
      observedContext: [] as any[],
    };

    const runtime = {
      tools: {
        start(input: any) {
          calls.started.push(input);
          return { allowed: true };
        },
        finish(input: any) {
          calls.finished.push(input);
          return undefined;
        },
      },
      context: {
        markCompacted(sessionId: string, input: any) {
          calls.compacted.push({ sessionId, input });
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
        record(input: any) {
          calls.events.push(input);
          return undefined;
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
    } as any;

    registerRuntimeCoreBridge(api, runtime);

    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);

    const sessionCtx = {
      sessionManager: {
        getSessionId: () => "core-1",
      },
      getContextUsage: () => ({ tokens: 320, contextWindow: 4096, percent: 0.078 }),
    };

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
      sessionCtx,
    );
    expect(beforeStart.systemPrompt?.includes("[Brewva Core Context Contract]")).toBe(true);
    expect(beforeStart.message?.content?.includes("[CoreTapeStatus]")).toBe(true);
    expect(beforeStart.message?.content?.includes("required_action: session_compact_now")).toBe(
      true,
    );
    expect(beforeStart.message?.details?.profile).toBe("runtime-core");
    expect(calls.observedContext).toHaveLength(1);
    expect(calls.observedContext[0].sessionId).toBe("core-1");

    const toolCallResult = invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-1",
        toolName: "exec",
        input: { command: "echo ok" },
      },
      sessionCtx,
    );
    expect(toolCallResult).toBeUndefined();
    expect(calls.started).toHaveLength(1);
    expect(calls.started[0].sessionId).toBe("core-1");
    expect(calls.started[0].toolName).toBe("exec");

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
      sessionCtx,
    );
    expect(calls.finished).toHaveLength(1);
    expect(calls.finished[0].sessionId).toBe("core-1");
    expect(calls.finished[0].toolCallId).toBe("tc-1");
    expect(calls.finished[0].success).toBe(true);

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
      sessionCtx,
    );
    expect(calls.compacted).toHaveLength(1);
    expect(calls.compacted[0].sessionId).toBe("core-1");
    expect(calls.events.some((event) => event.type === "session_compact")).toBe(true);

    invokeHandler(handlers, "session_shutdown", {}, sessionCtx);
    expect(calls.cleared).toEqual(["core-1"]);
  });

  test("returns block when runtime.startToolCall rejects", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = {
      tools: {
        start: () => ({ allowed: false, reason: "blocked" }),
        finish: () => undefined,
      },
      context: {
        markCompacted: () => undefined,
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          pressure: { level: "none", usageRatio: null, hardLimitRatio: 0.98 },
          recentCompaction: false,
          windowTurns: 2,
        }),
        getCompactionThresholdRatio: () => 0.8,
        getHardLimitRatio: () => 0.98,
        sanitizeInput: (text: string) => text,
      },
      events: {
        record: () => undefined,
        getTapeStatus: () => ({
          tapePressure: "none",
          totalEntries: 0,
          entriesSinceAnchor: 0,
          entriesSinceCheckpoint: 0,
          lastAnchor: undefined,
          thresholds: { low: 5, medium: 20, high: 50 },
        }),
        getTapePressureThresholds: () => ({ low: 5, medium: 20, high: 50 }),
      },
      session: {
        clearState: () => undefined,
      },
      config: {
        tape: {
          tapePressureThresholds: { low: 5, medium: 20, high: 50 },
        },
      },
    } as any;

    registerRuntimeCoreBridge(api, runtime);

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
