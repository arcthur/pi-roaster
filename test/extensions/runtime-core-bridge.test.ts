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
    };

    const runtime = {
      startToolCall(input: any) {
        calls.started.push(input);
        return { allowed: true };
      },
      finishToolCall(input: any) {
        calls.finished.push(input);
        return "ledger-1";
      },
      markContextCompacted(sessionId: string, input: any) {
        calls.compacted.push({ sessionId, input });
      },
      recordEvent(input: any) {
        calls.events.push(input);
      },
      clearSessionState(sessionId: string) {
        calls.cleared.push(sessionId);
      },
      sanitizeInput(text: string) {
        return text;
      },
    } as any;

    registerRuntimeCoreBridge(api, runtime);

    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);

    const sessionCtx = {
      sessionManager: {
        getSessionId: () => "core-1",
      },
      getContextUsage: () => ({ tokens: 320, contextWindow: 4096, percent: 0.078 }),
    };

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
      startToolCall: () => ({ allowed: false, reason: "blocked" }),
      finishToolCall: () => "ledger-1",
      markContextCompacted: () => undefined,
      recordEvent: () => undefined,
      clearSessionState: () => undefined,
      sanitizeInput: (text: string) => text,
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
