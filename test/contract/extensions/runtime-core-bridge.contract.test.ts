import { describe, expect, test } from "bun:test";
import { registerRuntimeCoreBridge } from "@brewva/brewva-gateway/runtime-plugins";
import { createRuntimeFixture as createBaseRuntimeFixture } from "../../helpers/runtime.js";
import {
  createMockExtensionAPI,
  invokeHandler,
  invokeHandlersAsync,
  invokeHandlers,
} from "../helpers/extension.js";

interface RuntimeCalls {
  started: Array<Record<string, unknown>>;
  finished: Array<Record<string, unknown>>;
  compacted: Array<{ sessionId: string; input: Record<string, unknown> }>;
  events: Array<Record<string, unknown>>;
  subscriptions: Array<(event: Record<string, unknown>) => void>;
  cleared: string[];
  observedContext: Array<{ sessionId: string; usage: unknown }>;
}

function createRuntimeFixture(
  input: {
    startAllowed?: boolean;
    startReason?: string;
    startAdvisory?: string;
  } = {},
) {
  const calls: RuntimeCalls = {
    started: [],
    finished: [],
    compacted: [],
    events: [],
    subscriptions: [],
    cleared: [],
    observedContext: [],
  };

  const runtime = createBaseRuntimeFixture();
  runtime.config.skills.routing.scopes = ["core", "domain"];

  Object.assign(runtime.tools, {
    start(payload: Record<string, unknown>) {
      calls.started.push(payload);
      return {
        allowed: input.startAllowed ?? true,
        reason: input.startReason,
        advisory: input.startAdvisory,
      };
    },
    explainAccess() {
      return { allowed: true };
    },
    finish(payload: Record<string, unknown>) {
      calls.finished.push(payload);
    },
  });

  Object.assign(runtime.context, {
    markCompacted(sessionId: string, payload: Record<string, unknown>) {
      calls.compacted.push({ sessionId, input: payload });
    },
    observeUsage(sessionId: string, usage: unknown) {
      calls.observedContext.push({ sessionId, usage });
    },
    getUsage() {
      return { tokens: 320, contextWindow: 4096, percent: 0.078 };
    },
    getPressureStatus(_sessionId: string, usage?: { percent?: number }) {
      return {
        level: "low",
        usageRatio: typeof usage?.percent === "number" ? usage.percent : 0.078,
        hardLimitRatio: 0.98,
        compactionThresholdRatio: 0.8,
      };
    },
    async buildInjection() {
      return {
        text: "",
        entries: [],
        accepted: false,
        originalTokens: 0,
        finalTokens: 0,
        truncated: false,
      };
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
    getPendingCompactionReason() {
      return "hard_limit";
    },
    getHardLimitRatio() {
      return 0.98;
    },
    sanitizeInput(text: string) {
      return text;
    },
  });

  Object.assign(runtime.events, {
    record(payload: Record<string, unknown>) {
      calls.events.push(payload);
      return undefined;
    },
    subscribe(handler: (event: Record<string, unknown>) => void) {
      calls.subscriptions.push(handler);
      return () => {
        const index = calls.subscriptions.indexOf(handler);
        if (index >= 0) {
          calls.subscriptions.splice(index, 1);
        }
      };
    },
    query() {
      return [];
    },
    queryStructured() {
      return [];
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
  });

  Object.assign(runtime.task, {
    getState() {
      return {
        spec: {
          goal: "Stabilize runtime core bridge behavior.",
        },
        status: {
          phase: "execute",
        },
        items: [],
        blockers: [],
      };
    },
  });

  Object.assign(runtime.skills, {
    getActive() {
      return null;
    },
    getPendingDispatch() {
      return undefined;
    },
    getCascadeIntent() {
      return undefined;
    },
    get() {
      return undefined;
    },
  });

  Object.assign(runtime.session, {
    clearState(sessionId: string) {
      calls.cleared.push(sessionId);
    },
  });

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
    registerRuntimeCoreBridge(api, runtime);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  test("given before_agent_start, when bridge handles context, then prompt is annotated with core contract", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime);

    const results = await invokeHandlersAsync<{
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
    const beforeStart = results.find(
      (result) =>
        typeof result?.systemPrompt === "string" || typeof result?.message?.content === "string",
    );
    if (!beforeStart) {
      throw new Error("Expected runtime core bridge before_agent_start output.");
    }
    expect(beforeStart.systemPrompt).toContain("[Brewva Context Contract]");
    expect(beforeStart.message?.content).toContain("[ContextCompactionGate]");
    expect(beforeStart.message?.content).toContain("[OperationalDiagnostics]");
    expect(beforeStart.message?.content).not.toContain("tape_pressure:");
    expect(beforeStart.message?.details?.profile).toBe("runtime-core");
    expect(calls.events.some((event) => event.type === "context_composed")).toBe(true);
    expect(calls.observedContext).toHaveLength(1);
    expect(calls.observedContext[0]?.sessionId).toBe("core-before-start");
  });

  test("given tool_call event, when bridge handles it, then runtime.tools.start is invoked", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime);

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

  test("given tool_result event, when bridge handles it, then ledger persistence finishes the runtime tool call", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime);
    invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-1",
        toolName: "exec",
        input: { command: "echo ok" },
      },
      createSessionContext("core-tool-result"),
    );
    invokeHandlers(
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
    expect(calls.finished[0]?.channelSuccess).toBe(true);
  });

  test("given advisory tool start, when tool_result runs, then advisory is returned without polluting runtime.finish", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture({
      startAdvisory:
        "[ExplorationAdvisory]\nSummarize what you know, then switch strategy before broadening the scan.",
    });
    registerRuntimeCoreBridge(api, runtime);
    invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-advisory",
        toolName: "look_at",
        input: { goal: "inspect the runtime boundary" },
      },
      createSessionContext("core-tool-advisory"),
    );

    const results = invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-advisory",
        toolName: "look_at",
        input: { goal: "inspect the runtime boundary" },
        isError: false,
        content: [{ type: "text", text: "original result" }],
        details: { durationMs: 1 },
      },
      createSessionContext("core-tool-advisory"),
    );
    const advisoryResult = results.find(
      (result) =>
        result &&
        typeof result === "object" &&
        Array.isArray((result as { content?: unknown }).content),
    ) as { content?: Array<{ text?: string }> } | undefined;

    expect(advisoryResult?.content?.[0]?.text).toContain("[ExplorationAdvisory]");
    expect(advisoryResult?.content?.[1]?.text).toBe("original result");
    expect(calls.finished).toHaveLength(1);
    expect(calls.finished[0]?.outputText).toBe("original result");
  });

  test("given session_compact event, when bridge handles it, then compaction is marked and event recorded", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime, calls } = createRuntimeFixture();
    registerRuntimeCoreBridge(api, runtime);
    invokeHandlers(
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
    registerRuntimeCoreBridge(api, runtime);
    invokeHandlers(handlers, "session_shutdown", {}, createSessionContext("core-shutdown"));
    expect(calls.cleared).toEqual(["core-shutdown"]);
  });

  test("given runtime.tools.start denied result, when handling tool_call, then bridge returns block response", () => {
    const { api, handlers } = createMockExtensionAPI();
    const { runtime } = createRuntimeFixture({
      startAllowed: false,
      startReason: "blocked",
    });
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
