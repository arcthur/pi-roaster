import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerContextTransform,
  registerEventStream,
  registerLedgerWriter,
  registerMemoryBridge,
  registerQualityGate,
} from "@brewva/brewva-extensions";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime, type BrewvaConfig } from "@brewva/brewva-runtime";
import {
  AuthStorage,
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

type Handler = (event: any, ctx: any) => unknown;
type DeepPartial<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

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

function invokeHandlers<T = unknown>(
  handlers: Map<string, Handler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  options: { stopOnBlock?: boolean } = {},
): T[] {
  const list = handlers.get(eventName) ?? [];
  const results: T[] = [];

  for (const handler of list) {
    const result = handler(event, ctx) as T;
    results.push(result);

    if (
      options.stopOnBlock &&
      result &&
      typeof result === "object" &&
      "block" in (result as Record<string, unknown>) &&
      (result as Record<string, unknown>).block === true
    ) {
      break;
    }
  }

  return results;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T;
  }
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = output[key];
    output[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

function buildRuntimeConfig(patch?: DeepPartial<BrewvaConfig>): BrewvaConfig {
  return deepMerge<BrewvaConfig>(DEFAULT_BREWVA_CONFIG, patch);
}

function withRuntimeConfig<T extends Record<string, unknown>>(
  runtime: T,
  patch?: DeepPartial<BrewvaConfig>,
): T & { config: BrewvaConfig } {
  const runtimePatch = (runtime as { config?: DeepPartial<BrewvaConfig> }).config;
  const config = buildRuntimeConfig(patch ?? runtimePatch);
  const normalizeRatio = (value: number | null | undefined): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value >= 0 && value <= 1) return value;
    if (value > 1 && value <= 100) return value / 100;
    if (value < 0) return 0;
    return 1;
  };
  const resolveUsageRatio = (usage: unknown): number | null => {
    const normalized = usage as
      | { tokens?: unknown; contextWindow?: unknown; percent?: unknown }
      | undefined;
    if (!normalized) return null;
    const byPercent = normalizeRatio(
      typeof normalized.percent === "number" ? normalized.percent : null,
    );
    if (byPercent !== null) return byPercent;
    if (
      typeof normalized.tokens !== "number" ||
      typeof normalized.contextWindow !== "number" ||
      normalized.tokens < 0 ||
      normalized.contextWindow <= 0
    ) {
      return null;
    }
    return Math.max(0, Math.min(1, normalized.tokens / normalized.contextWindow));
  };
  const hardLimitRatio = normalizeRatio(config.infrastructure.contextBudget.hardLimitPercent) ?? 1;
  const compactionThresholdRatio =
    normalizeRatio(config.infrastructure.contextBudget.compactionThresholdPercent) ??
    hardLimitRatio;
  const defaults = {
    recordEvent: () => undefined,
    clearSessionState: () => undefined,
    queryEvents: () => [],
    getTapeStatus: () => ({
      totalEntries: 0,
      entriesSinceAnchor: 0,
      entriesSinceCheckpoint: 0,
      tapePressure: "none",
      thresholds: {
        low: config.tape.tapePressureThresholds.low,
        medium: config.tape.tapePressureThresholds.medium,
        high: config.tape.tapePressureThresholds.high,
      },
      lastAnchor: undefined,
      lastCheckpointId: undefined,
    }),
    getContextHardLimitRatio: () => hardLimitRatio,
    getContextCompactionThresholdRatio: () => compactionThresholdRatio,
    getContextPressureStatus: (_sessionId: string, usage?: unknown) => {
      const usageRatio = resolveUsageRatio(usage);
      if (usageRatio === null) {
        return {
          level: "unknown",
          usageRatio: null,
          hardLimitRatio,
          compactionThresholdRatio,
        };
      }

      if (usageRatio >= hardLimitRatio) {
        return {
          level: "critical",
          usageRatio,
          hardLimitRatio,
          compactionThresholdRatio,
        };
      }
      if (usageRatio >= compactionThresholdRatio) {
        return {
          level: "high",
          usageRatio,
          hardLimitRatio,
          compactionThresholdRatio,
        };
      }
      const mediumThreshold = Math.max(0.5, compactionThresholdRatio * 0.75);
      if (usageRatio >= mediumThreshold) {
        return {
          level: "medium",
          usageRatio,
          hardLimitRatio,
          compactionThresholdRatio,
        };
      }
      const lowThreshold = Math.max(0.25, compactionThresholdRatio * 0.5);
      return {
        level: usageRatio >= lowThreshold ? "low" : "none",
        usageRatio,
        hardLimitRatio,
        compactionThresholdRatio,
      };
    },
    planSupplementalContextInjection: (_sessionId: string, inputText: string) => ({
      accepted: true,
      text: inputText,
      originalTokens: 0,
      finalTokens: 0,
      truncated: false,
    }),
    commitSupplementalContextInjection: () => undefined,
  };
  return {
    ...defaults,
    ...runtime,
    config,
  };
}

describe("Extension gaps: context transform", () => {
  test("registers context hooks and injects hidden context message", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: () => undefined,
      buildContextInjection: () => ({
        text: "[Brewva Context]\nTop-K Skill Candidates:\n- debugging",
        accepted: true,
        originalTokens: 42,
        finalTokens: 42,
        truncated: false,
      }),
    } as any);

    registerContextTransform(api, runtime);

    expect(handlers.has("context")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("tool_call")).toBe(false);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("turn_end")).toBe(false);
    expect(handlers.has("agent_end")).toBe(false);

    const result = invokeHandler<{
      systemPrompt?: string;
      message: {
        customType: string;
        content: string;
        display: boolean;
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "fix test failure",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(result.message.customType).toBe("brewva-context-injection");
    expect(result.message.display).toBe(false);
    expect(result.message.content.includes("[Brewva Context]")).toBe(true);
    expect(result.message.content.includes("debugging")).toBe(true);
    expect(result.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
  });

  test("does not inject context message when budget drops injection", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: () => undefined,
      buildContextInjection: () => ({
        text: "",
        accepted: false,
        originalTokens: 4200,
        finalTokens: 0,
        truncated: false,
      }),
    } as any);

    registerContextTransform(api, runtime);

    const result = invokeHandler<{ systemPrompt?: string; message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "fix test failure",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s1-drop",
        },
        getContextUsage: () => ({ tokens: 520, contextWindow: 1000, percent: 0.52 }),
      },
    );

    expect(result.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(result.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(result.message?.content?.includes("[Brewva Context]")).toBe(false);
  });

  test("passes leaf id into runtime injection scope", () => {
    const { api, handlers } = createMockExtensionAPI();
    const scopes: Array<string | undefined> = [];
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: () => undefined,
      buildContextInjection: (
        _sessionId: string,
        _prompt: string,
        _usage: unknown,
        scopeId?: string,
      ) => {
        scopes.push(scopeId);
        return {
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        };
      },
    } as any);

    registerContextTransform(api, runtime);

    invokeHandler(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "fix test failure",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s1",
          getLeafId: () => "leaf-1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(scopes).toEqual(["leaf-1"]);
  });

  test("records non-interactive compaction skip when compaction is requested", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => true,
      markContextCompacted: () => undefined,
      recordEvent: (input: { type: string; payload?: { reason?: string } }) => {
        if (input.type === "context_compaction_skipped" && input.payload?.reason) {
          skippedReasons.push(input.payload.reason);
        }
      },
      buildContextInjection: () => ({
        text: "",
        accepted: false,
        originalTokens: 0,
        finalTokens: 0,
        truncated: false,
      }),
    } as any);

    registerContextTransform(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1 },
      { sessionManager: { getSessionId: () => "s-print" } },
    );
    invokeHandler(
      handlers,
      "context",
      {},
      {
        hasUI: false,
        sessionManager: {
          getSessionId: () => "s-print",
        },
        getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 0.99 }),
      },
    );

    expect(skippedReasons).toContain("non_interactive_mode");
  });

  test("gates non-session_compact tools when context pressure is critical", () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];
    const capturedCompactions: Array<Record<string, unknown>> = [];

    const runtime = withRuntimeConfig(
      {
        onTurnStart: () => undefined,
        observeContextUsage: () => undefined,
        shouldRequestCompaction: () => true,
        markContextCompacted: (_sessionId: string, payload: Record<string, unknown>) => {
          capturedCompactions.push(payload);
        },
        recordEvent: (input: { type: string }) => {
          eventTypes.push(input.type);
        },
        buildContextInjection: () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      } as any,
      {
        infrastructure: {
          contextBudget: {
            hardLimitPercent: 0.8,
          },
        },
      },
    );

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-gate",
    };

    const before = invokeHandler<{ message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "round-1",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );

    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(true);
    expect(before.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(before.message?.content?.includes("tape_pressure:")).toBe(true);
    expect(before.message?.content?.includes("required_action: session_compact_now")).toBe(true);
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1 },
      {
        sessionManager,
      },
    );

    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-1",
          summary: "Keep active goals only.",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1200, contextWindow: 4096, percent: 0.29 }),
      },
    );

    expect(capturedCompactions).toHaveLength(1);
    expect(capturedCompactions[0]?.entryId).toBe("cmp-entry-1");
    expect(capturedCompactions[0]?.summary).toBe("Keep active goals only.");
    expect(capturedCompactions[0]?.toTokens).toBe(1200);
    expect(eventTypes).toContain("session_compact");
    expect(eventTypes).toContain("context_compaction_gate_cleared");
  });

  test("does not arm gate when critical usage has recent compaction", () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = withRuntimeConfig(
      {
        onTurnStart: () => undefined,
        observeContextUsage: () => undefined,
        shouldRequestCompaction: () => true,
        markContextCompacted: () => undefined,
        recordEvent: (input: { type: string }) => {
          eventTypes.push(input.type);
        },
        buildContextInjection: () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      } as any,
      {
        infrastructure: {
          contextBudget: {
            hardLimitPercent: 0.8,
          },
        },
      },
    );

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-recent-compact",
    };

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 3 },
      {
        sessionManager,
      },
    );

    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-recent",
          summary: "recent compaction",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1000, contextWindow: 4096, percent: 0.24 }),
      },
    );

    const before = invokeHandler<{ systemPrompt?: string; message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "round-after-compact",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );

    expect(before.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(before.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });

  test("treats compaction as recent for configured N-turn window", () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = withRuntimeConfig(
      {
        onTurnStart: () => undefined,
        observeContextUsage: () => undefined,
        shouldRequestCompaction: () => true,
        markContextCompacted: () => undefined,
        queryEvents: () => [],
        recordEvent: (input: { type: string }) => {
          eventTypes.push(input.type);
        },
        buildContextInjection: () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      } as any,
      {
        infrastructure: {
          contextBudget: {
            hardLimitPercent: 0.8,
            minTurnsBetweenCompaction: 2,
          },
        },
      },
    );

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-window",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 3 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-window",
          summary: "window compact",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 500, contextWindow: 4096, percent: 0.12 }),
      },
    );

    invokeHandler(handlers, "turn_start", { turnIndex: 4 }, { sessionManager });
    const withinWindow = invokeHandler<{ message?: { content?: string }; systemPrompt?: string }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "within-window",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );
    expect(withinWindow.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(withinWindow.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(withinWindow.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");

    invokeHandler(handlers, "turn_start", { turnIndex: 5 }, { sessionManager });
    const afterWindow = invokeHandler<{ message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "after-window",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      },
    );
    expect(afterWindow.message?.content?.includes("[ContextCompactionGate]")).toBe(true);
    expect(afterWindow.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(afterWindow.message?.content?.includes("tape_pressure:")).toBe(true);
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
  });

  test("hydrates recent compaction from tape events before gating", () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = withRuntimeConfig(
      {
        onTurnStart: () => undefined,
        observeContextUsage: () => undefined,
        shouldRequestCompaction: () => true,
        markContextCompacted: () => undefined,
        queryEvents: (_sessionId: string, query: { type?: string; last?: number }) => {
          if (query.type === "context_compacted" && query.last === 1) {
            return [{ turn: 7 }];
          }
          return [];
        },
        recordEvent: (input: { type: string }) => {
          eventTypes.push(input.type);
        },
        buildContextInjection: () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      } as any,
      {
        infrastructure: {
          contextBudget: {
            hardLimitPercent: 0.8,
            minTurnsBetweenCompaction: 2,
          },
        },
      },
    );

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-hydrate",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 8 }, { sessionManager });

    const before = invokeHandler<{ systemPrompt?: string; message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "hydrated-compact",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );

    expect(before.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(before.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });
});

describe("Extension gaps: memory bridge", () => {
  test("refreshes memory on agent_end and clears cache on session_shutdown", () => {
    const { api, handlers } = createMockExtensionAPI();
    const calls: Array<{ kind: "refresh" | "clear"; sessionId: string }> = [];
    const runtime = withRuntimeConfig({
      memory: {
        refreshIfNeeded: ({ sessionId }: { sessionId: string }) => {
          calls.push({ kind: "refresh", sessionId });
          return undefined;
        },
        clearSessionCache: (sessionId: string) => {
          calls.push({ kind: "clear", sessionId });
        },
      },
    } as any);

    registerMemoryBridge(api, runtime);

    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);

    invokeHandler(
      handlers,
      "agent_end",
      { type: "agent_end", messages: [] },
      {
        sessionManager: {
          getSessionId: () => "s-memory-bridge",
        },
      },
    );
    invokeHandler(
      handlers,
      "session_shutdown",
      { type: "session_shutdown" },
      {
        sessionManager: {
          getSessionId: () => "s-memory-bridge",
        },
      },
    );

    expect(calls).toEqual([
      { kind: "refresh", sessionId: "s-memory-bridge" },
      { kind: "clear", sessionId: "s-memory-bridge" },
    ]);
  });
});
describe("Extension gaps: event stream", () => {
  // Covered by "Extension integration: observability > persists throttled message_update events"
});

describe("Extension gaps: quality gate", () => {
  test("transforms input when sanitizeInput changes text", () => {
    const { api, handlers } = createMockExtensionAPI();

    const runtime = withRuntimeConfig({
      startToolCall: () => ({ allowed: true }),
      sanitizeInput: (text: string) => `sanitized:${text}`,
    } as any);

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string; text?: string; images?: unknown[] }>(
      handlers,
      "input",
      {
        source: "user",
        text: "hello",
        images: [{ type: "image", url: "test://image" }],
      },
      {},
    );

    expect(result.action).toBe("transform");
    expect(result.text).toBe("sanitized:hello");
    expect(result.images).toHaveLength(1);
  });

  test("continues input when sanitizeInput is a no-op", () => {
    const { api, handlers } = createMockExtensionAPI();

    const runtime = withRuntimeConfig({
      startToolCall: () => ({ allowed: true }),
      sanitizeInput: (text: string) => text,
    } as any);

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string }>(
      handlers,
      "input",
      {
        source: "user",
        text: "hello",
        images: [],
      },
      {},
    );

    expect(result.action).toBe("continue");
  });

  test("delegates tool_call gate to runtime.startToolCall with normalized usage", () => {
    const { api, handlers } = createMockExtensionAPI();
    const calls: any[] = [];
    const runtime = withRuntimeConfig({
      startToolCall: (input: any) => {
        calls.push(input);
        return { allowed: true };
      },
      sanitizeInput: (text: string) => text,
    } as any);

    registerQualityGate(api, runtime);

    const result = invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-quality",
        toolName: "exec",
        input: { command: "echo hi" },
      },
      {
        sessionManager: { getSessionId: () => "qg-1" },
        getContextUsage: () => ({ tokens: 123, contextWindow: 4096, percent: 0.03 }),
      },
    );

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("qg-1");
    expect(calls[0].toolCallId).toBe("tc-quality");
    expect(calls[0].toolName).toBe("exec");
    expect(calls[0].args).toEqual({ command: "echo hi" });
    expect(calls[0].usage.tokens).toBe(123);
    expect(calls[0].usage.contextWindow).toBe(4096);
  });

  test("blocks tool_call when runtime.startToolCall rejects", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = withRuntimeConfig({
      startToolCall: () => ({
        allowed: false,
        reason: "blocked-by-runtime",
      }),
      sanitizeInput: (text: string) => text,
    } as any);

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ block?: boolean; reason?: string }>(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-block",
        toolName: "exec",
        input: { command: "false" },
      },
      {
        sessionManager: { getSessionId: () => "qg-2" },
        getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      },
    );

    expect(result.block).toBe(true);
    expect(result.reason).toBe("blocked-by-runtime");
  });
});

describe("Extension gaps: ledger writer", () => {
  test("records tool_result with extracted text and fail verdict when isError=true", () => {
    const { api, handlers } = createMockExtensionAPI();

    const finished: any[] = [];
    const runtime = withRuntimeConfig({
      finishToolCall: (input: any) => {
        finished.push(input);
      },
    } as any);

    registerLedgerWriter(api, runtime);

    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-err",
        toolName: "exec",
        input: { command: "false" },
        isError: true,
        content: [
          { type: "text", text: "line-a" },
          { type: "json", value: { ok: false } },
          { type: "text", text: "line-b" },
        ],
        details: { durationMs: 12 },
      },
      {
        sessionManager: {
          getSessionId: () => "lw-1",
        },
      },
    );

    expect(finished).toHaveLength(1);
    expect(finished[0].sessionId).toBe("lw-1");
    expect(finished[0].toolName).toBe("exec");
    expect(finished[0].success).toBe(false);
    expect(finished[0].verdict).toBe("fail");
    expect(finished[0].outputText).toBe("line-a\nline-b");
    expect(finished[0].metadata.toolCallId).toBe("tc-err");
  });
});

describe("Extension integration: observability", () => {
  test("emits context injection on before_agent_start via SDK runner contract", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-dual-injection-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });
    mkdirSync(join(workspace, ".brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: true,
            dailyRefreshHourLocal: 0,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const agentDir = join(workspace, ".brewva-agent-test-dual-injection");

    const extensionPath = join(workspace, "brewva-inline-extension.ts");
    const brewvaExtensionEntry = join(
      process.cwd(),
      "packages/brewva-extensions/src/index.ts",
    ).replaceAll("\\", "/");
    writeFileSync(
      extensionPath,
      [
        `import { createBrewvaExtension } from '${brewvaExtensionEntry}';`,
        `export default createBrewvaExtension({ registerTools: false, cwd: ${JSON.stringify(workspace)} });`,
      ].join("\n"),
      "utf8",
    );

    const loaded = await discoverAndLoadExtensions(
      [extensionPath],
      workspace,
      agentDir,
      createEventBus(),
    );
    expect(loaded.errors).toHaveLength(0);

    const sessionManager = SessionManager.inMemory(workspace);
    const modelRegistry = new ModelRegistry(
      AuthStorage.create(join(workspace, ".auth-test.json")),
      join(workspace, ".models-test.json"),
    );
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      workspace,
      sessionManager,
      modelRegistry,
    );

    runner.bindCore(
      {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        appendEntry: () => undefined,
        setSessionName: () => undefined,
        getSessionName: () => undefined,
        setLabel: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "medium",
        setThinkingLevel: () => undefined,
      },
      {
        getModel: () => undefined,
        isIdle: () => true,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => ({ tokens: 700, contextWindow: 4000, percent: 0.175 }),
        compact: () => undefined,
        getSystemPrompt: () => "base",
      },
    );

    await runner.emit({ type: "agent_end", messages: [] });

    const result = await runner.emitBeforeAgentStart(
      "continue fixing flaky tests",
      undefined,
      "base",
    );
    const messageTypes = (result?.messages ?? []).map((message) => message.customType);
    const mergedContent = (result?.messages ?? [])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");

    expect(result?.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(messageTypes).toEqual(["brewva-context-injection"]);
    expect(mergedContent.includes("[WorkingMemory]")).toBe(true);
  });

  test("tool call + tool result produces correlated events, ledger row, and patch record", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/a.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-obs-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerContextTransform(api, runtime);
    registerQualityGate(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "session_start", {}, ctx);
    invokeHandlers(handlers, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);

    const toolCallId = "tc-edit-1";
    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId,
        toolName: "edit",
        input: {
          file_path: "src/a.ts",
          old_text: "export const value = 1;\n",
          new_text: "export const value = 2;\n",
        },
      },
      ctx,
      { stopOnBlock: true },
    );

    writeFileSync(join(workspace, "src/a.ts"), "export const value = 2;\n", "utf8");

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId,
        toolName: "edit",
        input: { file_path: "src/a.ts" },
        isError: false,
        content: [{ type: "text", text: "edited" }],
        details: { durationMs: 2 },
      },
      ctx,
    );

    const ledgerRows = runtime.ledger.list(sessionId);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.tool).toBe("edit");

    const recorded = runtime.queryEvents(sessionId, { type: "tool_result_recorded", last: 1 })[0];
    expect(recorded).toBeDefined();
    const payload = recorded?.payload as { ledgerId?: string } | undefined;
    expect(payload?.ledgerId).toBe(ledgerRows[0]?.id);
    expect(runtime.queryEvents(sessionId, { type: "tool_result", last: 1 })).toHaveLength(0);

    const snapshot = runtime.queryEvents(sessionId, { type: "file_snapshot_captured", last: 1 })[0];
    expect(snapshot).toBeDefined();
    const snapshotPayload = snapshot?.payload as { files?: string[] } | undefined;
    expect(snapshotPayload?.files).toContain("src/a.ts");

    const patchRecorded = runtime.queryEvents(sessionId, { type: "patch_recorded", last: 1 })[0];
    expect(patchRecorded).toBeDefined();
    const patchPayload = patchRecorded?.payload as
      | { changes?: Array<{ path: string; action: string }> }
      | undefined;
    expect(patchPayload?.changes).toEqual([{ path: "src/a.ts", action: "modify" }]);

    const reloaded = new BrewvaRuntime({ cwd: workspace });
    expect(reloaded.queryEvents(sessionId).length).toBeGreaterThan(0);
    expect(reloaded.ledger.list(sessionId)).toHaveLength(1);
  });

  test("session_shutdown clears runtime in-memory session state", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-shutdown-clean-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-shutdown-clean-1";

    runtime.onTurnStart(sessionId, 1);
    runtime.markToolCall(sessionId, "edit");
    runtime.observeContextUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      success: true,
    });

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);

    invokeHandlers(
      handlers,
      "session_shutdown",
      {},
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    expect((runtime as any).turnsBySession.has(sessionId)).toBe(false);
    expect((runtime as any).toolCallsBySession.has(sessionId)).toBe(false);
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
  });

  test("blocked tool call is still observable as tool_call but not tool_call_marked", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-blocked-"));
    mkdirSync(join(workspace, "skills/base/patching"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/base/patching/SKILL.md"),
      `---
name: patching
description: patching skill
tier: base
tags: [patching]
tools:
  required: [read]
  optional: [edit]
  denied: [write]
budget:
  max_tool_calls: 10
  max_tokens: 10000
---
patching`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-blocked-1";
    expect(runtime.activateSkill(sessionId, "patching").ok).toBe(true);

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const toolCallId = "tc-write-1";
    const results = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId,
        toolName: "write",
        input: { file_path: "src/a.ts", content: "x" },
      },
      ctx,
      { stopOnBlock: true },
    );

    expect(results.some((result) => (result as any)?.block === true)).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "tool_call", last: 1 })).toHaveLength(1);
    expect(runtime.queryEvents(sessionId, { type: "tool_call_marked", last: 1 })).toHaveLength(0);
    expect(
      runtime.queryEvents(sessionId, { type: "file_snapshot_captured", last: 1 }),
    ).toHaveLength(0);
  });

  test("skill max_tool_calls enforce blocks normal tools but allows skill_complete in extension chain", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-max-tool-calls-"));
    mkdirSync(join(workspace, ".brewva/skills/base/maxcalls"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/base/maxcalls/SKILL.md"),
      `---
name: maxcalls
description: maxcalls skill
tier: base
tags: [maxcalls]
tools:
  required: [read]
  optional: [edit]
  denied: [write]
budget:
  max_tool_calls: 1
  max_tokens: 10000
---
maxcalls`,
      "utf8",
    );

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.security.allowedToolsMode = "off";
    config.security.skillMaxToolCallsMode = "enforce";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "ext-max-tool-calls-1";
    expect(runtime.activateSkill(sessionId, "maxcalls").ok).toBe(true);
    expect(runtime.getActiveSkill(sessionId)?.contract.budget.maxToolCalls).toBe(1);

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    runtime.markToolCall(sessionId, "read");

    const blocked = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-grep-1",
        toolName: "grep",
        input: { pattern: "x", include: "*.ts" },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(blocked.some((result) => (result as { block?: boolean })?.block === true)).toBe(true);

    const lifecycle = invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete-2",
        toolName: "skill_complete",
        input: { outputs: {} },
      },
      ctx,
      { stopOnBlock: true },
    );
    expect(lifecycle.some((result) => (result as { block?: boolean })?.block === true)).toBe(false);

    expect(runtime.queryEvents(sessionId, { type: "tool_call" })).toHaveLength(2);
    expect(runtime.queryEvents(sessionId, { type: "tool_call_marked" })).toHaveLength(2);
    const blockedEvents = runtime.queryEvents(sessionId, { type: "tool_call_blocked" });
    expect(
      blockedEvents.some(
        (event) =>
          typeof event.payload?.reason === "string" &&
          event.payload.reason.includes("maxToolCalls"),
      ),
    ).toBe(true);
  });

  test("persists throttled message_update events", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-throttle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "ext-throttle-1";

    const { api, handlers } = createMockExtensionAPI();
    registerEventStream(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;

    try {
      invokeHandlers(
        handlers,
        "message_start",
        { message: { role: "assistant", content: [] } },
        ctx,
      );

      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "a" }] },
          assistantMessageEvent: { type: "text_delta", delta: "a" },
        },
        ctx,
      );
      now += 100;
      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
          assistantMessageEvent: { type: "text_delta", delta: "b" },
        },
        ctx,
      );
      now += 300;
      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
          assistantMessageEvent: { type: "text_delta", delta: "c" },
        },
        ctx,
      );
    } finally {
      Date.now = originalNow;
    }

    const updates = runtime.queryEvents(sessionId, { type: "message_update" });
    expect(updates.length).toBe(2);
    const payload = updates[0]?.payload as any;
    expect(payload.deltaChars).toBe(1);
    expect(payload.health).toBeTruthy();
    expect(typeof payload.health.score).toBe("number");
  });
});
