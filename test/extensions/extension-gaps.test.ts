import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AuthStorage,
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
  registerContextTransform,
  registerEventStream,
  registerLedgerWriter,
  registerMemory,
  registerQualityGate,
} from "@pi-roaster/roaster-extensions";
import { DEFAULT_ROASTER_CONFIG, RoasterRuntime, type RoasterConfig } from "@pi-roaster/roaster-runtime";

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

function createLedgerRow(input: {
  id: string;
  timestamp: number;
  tool: string;
  verdict: "pass" | "fail" | "inconclusive";
  argsSummary: string;
  outputSummary: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    timestamp: input.timestamp,
    turn: 1,
    skill: undefined,
    tool: input.tool,
    argsSummary: input.argsSummary,
    outputSummary: input.outputSummary,
    outputHash: "hash",
    verdict: input.verdict,
    sessionId: input.sessionId,
    previousHash: "root",
    hash: "hash",
  };
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
    output[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

function buildRuntimeConfig(patch?: DeepPartial<RoasterConfig>): RoasterConfig {
  return deepMerge<RoasterConfig>(DEFAULT_ROASTER_CONFIG, patch);
}

function withRuntimeConfig<T extends Record<string, unknown>>(
  runtime: T,
  patch?: DeepPartial<RoasterConfig>,
): T & { config: RoasterConfig } {
  const runtimePatch = (runtime as { config?: DeepPartial<RoasterConfig> }).config;
  const defaults = {
    recordEvent: () => undefined,
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
    config: buildRuntimeConfig(patch ?? runtimePatch),
  };
}

describe("Extension gaps: context transform", () => {
  test("registers context budget hooks and injects context as hidden custom message", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: () => undefined,
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
      },
      buildContextInjection: () => ({
        text: "[Roaster Context]\nTop-K Skill Candidates:\n- debugging",
        accepted: true,
        originalTokens: 42,
        finalTokens: 42,
        truncated: false,
      }),
    } as any);

    registerContextTransform(api, runtime);
    expect(handlers.has("context")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);

    const result = invokeHandler<{
      message: {
        customType: string;
        content: string;
        display: boolean;
      };
      systemPrompt?: string;
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

    expect(result.systemPrompt).toBeUndefined();
    expect(result.message.customType).toBe("roaster-context-injection");
    expect(result.message.display).toBe(false);
    expect(result.message.content.includes("[Roaster Context]")).toBe(true);
    expect(result.message.content.includes("debugging")).toBe(true);
  });

  test("does not inject context message when budget drops injection", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: () => undefined,
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
      },
      buildContextInjection: () => ({
        text: "",
        accepted: false,
        originalTokens: 4200,
        finalTokens: 0,
        truncated: false,
      }),
    } as any);

    registerContextTransform(api, runtime);

    const result = invokeHandler<unknown>(
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
        getContextUsage: () => ({ tokens: 999, contextWindow: 1000, percent: 0.999 }),
      },
    );

    expect(result).toBeUndefined();
  });

  test("passes leaf id into runtime injection scope", () => {
    const { api, handlers } = createMockExtensionAPI();
    const scopes: Array<string | undefined> = [];
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: () => undefined,
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
      },
      buildContextInjection: (_sessionId: string, _prompt: string, _usage: unknown, scopeId?: string) => {
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

  test("opens compaction breaker after missing compaction result and skips during cooldown", () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];
    let compactCalls = 0;
    const runtime = withRuntimeConfig({
      config: {
        infrastructure: {
          contextBudget: {
            compactionCircuitBreaker: {
              enabled: true,
              maxConsecutiveFailures: 1,
              cooldownTurns: 2,
            },
          },
        },
      },
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => true,
      markContextCompacted: () => undefined,
      recordEvent: (input: { type: string }) => {
        eventTypes.push(input.type);
      },
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
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

    const contextCtx = {
      sessionManager: {
        getSessionId: () => "s-breaker",
      },
      getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      compact: () => {
        compactCalls += 1;
      },
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 1 }, { sessionManager: contextCtx.sessionManager });
    invokeHandler(handlers, "context", {}, contextCtx);
    expect(compactCalls).toBe(1);

    invokeHandler(handlers, "turn_start", { turnIndex: 2 }, { sessionManager: contextCtx.sessionManager });
    invokeHandler(handlers, "context", {}, contextCtx);
    expect(compactCalls).toBe(1);

    invokeHandler(handlers, "turn_start", { turnIndex: 3 }, { sessionManager: contextCtx.sessionManager });
    invokeHandler(handlers, "context", {}, contextCtx);
    expect(compactCalls).toBe(1);

    invokeHandler(handlers, "turn_start", { turnIndex: 4 }, { sessionManager: contextCtx.sessionManager });
    invokeHandler(handlers, "context", {}, contextCtx);
    expect(compactCalls).toBe(2);

    expect(eventTypes.includes("context_compaction_breaker_opened")).toBe(true);
    expect(eventTypes.includes("context_compaction_skipped")).toBe(true);
    expect(eventTypes.includes("context_compaction_breaker_closed")).toBe(true);
  });

  test("clears compaction circuit state on session shutdown", () => {
    const { api, handlers } = createMockExtensionAPI();
    let compactCalls = 0;
    const runtime = withRuntimeConfig({
      config: {
        infrastructure: {
          contextBudget: {
            compactionCircuitBreaker: {
              enabled: true,
              maxConsecutiveFailures: 1,
              cooldownTurns: 2,
            },
          },
        },
      },
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => true,
      markContextCompacted: () => undefined,
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
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

    const sessionManager = {
      getSessionId: () => "s-shutdown-reset",
    };
    const contextCtx = {
      sessionManager,
      getContextUsage: () => ({ tokens: 960, contextWindow: 1000, percent: 0.96 }),
      compact: () => {
        compactCalls += 1;
      },
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 1 }, { sessionManager });
    invokeHandler(handlers, "context", {}, contextCtx);
    expect(compactCalls).toBe(1);

    invokeHandler(handlers, "session_shutdown", { type: "session_shutdown" }, { sessionManager });

    invokeHandler(handlers, "turn_start", { turnIndex: 2 }, { sessionManager });
    invokeHandler(handlers, "context", {}, contextCtx);
    expect(compactCalls).toBe(2);
  });

  test("opens breaker when compact call throws and continues without crashing", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];
    const runtime = withRuntimeConfig({
      config: {
        infrastructure: {
          contextBudget: {
            compactionCircuitBreaker: {
              enabled: true,
              maxConsecutiveFailures: 1,
              cooldownTurns: 1,
            },
          },
        },
      },
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => true,
      markContextCompacted: () => undefined,
      recordEvent: (input: { type: string; payload?: { reason?: string } }) => {
        if (input.type === "context_compaction_skipped" && input.payload?.reason) {
          skippedReasons.push(input.payload.reason);
        }
      },
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
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

    invokeHandler(handlers, "turn_start", { turnIndex: 1 }, { sessionManager: { getSessionId: () => "s-throw" } });
    invokeHandler(
      handlers,
      "context",
      {},
      {
        sessionManager: {
          getSessionId: () => "s-throw",
        },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 0.9 }),
        compact: () => {
          throw new Error("compact failed");
        },
      },
    );

    expect(skippedReasons).toContain("compact_call_failed");
  });

  test("forwards compaction entry metadata into runtime compaction marker", () => {
    const { api, handlers } = createMockExtensionAPI();
    const captured: Array<Record<string, unknown>> = [];
    const runtime = withRuntimeConfig({
      onTurnStart: () => undefined,
      observeContextUsage: () => undefined,
      shouldRequestCompaction: () => false,
      markContextCompacted: (_sessionId: string, input: Record<string, unknown>) => {
        captured.push(input);
      },
      contextBudget: {
        getCompactionInstructions: () => "compact stale context",
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
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-1",
          summary: "Keep active goals only.",
        },
      },
      {
        sessionManager: {
          getSessionId: () => "s1",
        },
        getContextUsage: () => ({ tokens: 1200, contextWindow: 4096, percent: 0.29 }),
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.entryId).toBe("cmp-entry-1");
    expect(captured[0]?.summary).toBe("Keep active goals only.");
    expect(captured[0]?.toTokens).toBe(1200);
  });
});

describe("Extension gaps: user-scoped memory", () => {
  test("persists user memory outside session scope and injects it on next session", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        getLedgerDigest: (sessionId: string) =>
          `[EvidenceDigest session=${sessionId}]\ncount=2 pass=1 fail=1 inconclusive=0\n- read(pass) src/a.ts\n- edit(fail) src/b.ts`,
        ledger: {
          query: (sessionId: string) => [
            createLedgerRow({
              id: "ev-1",
              timestamp: 1,
              tool: "skill_load",
              verdict: "pass",
              argsSummary: "patching",
              outputSummary: "loaded",
              sessionId,
            }),
            createLedgerRow({
              id: "ev-2",
              timestamp: 2,
              tool: "edit",
              verdict: "pass",
              argsSummary: "src/app.ts",
              outputSummary: "updated",
              sessionId,
            }),
            createLedgerRow({
              id: "ev-3",
              timestamp: 3,
              tool: "roaster_verify",
              verdict: "fail",
              argsSummary: "tests",
              outputSummary: "1 failed",
              sessionId,
            }),
          ],
        },
      } as any);

      registerMemory(api, runtime);

      invokeHandler(
        handlers,
        "agent_end",
        { type: "agent_end" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-a",
          },
        },
      );

      const userMemoryPath = join(dirname(agentDir), "memory", "user-preferences.json");
      expect(existsSync(userMemoryPath)).toBe(true);
      const userMemory = JSON.parse(readFileSync(userMemoryPath, "utf8")) as { lastDigest?: string; lastHandoff?: string };
      expect(userMemory.lastDigest?.includes("[EvidenceDigest session=session-a]")).toBe(true);
      expect(userMemory.lastHandoff?.includes("[SessionHandoff]")).toBe(true);
      expect(userMemory.lastHandoff?.includes("decisions:")).toBe(true);
      expect(userMemory.lastHandoff?.includes("artifacts:")).toBe(true);
      expect(userMemory.lastHandoff?.includes("antiPatterns:")).toBe(true);

      const injected = invokeHandler<{
        message: {
          customType: string;
          content: string;
          display: boolean;
        };
        systemPrompt?: string;
      }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
          },
        },
      );

      expect(injected.systemPrompt).toBeUndefined();
      expect(injected.message.customType).toBe("roaster-memory-injection");
      expect(injected.message.display).toBe(false);
      expect(injected.message.content.includes("[UserMemoryHandoff]")).toBe(true);
      expect(injected.message.content.includes("decisions:")).toBe(true);
      expect(injected.message.content.includes("[UserMemoryDigest]")).toBe(true);
      expect(injected.message.content.includes("[EvidenceDigest session=session-a]")).toBe(true);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("deduplicates memory injection per branch and resets on compaction", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-dedup-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-dedup");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        getLedgerDigest: (sessionId: string) =>
          `[EvidenceDigest session=${sessionId}]\ncount=1 pass=1 fail=0 inconclusive=0\n- read(pass) src/a.ts`,
      } as any);

      registerMemory(api, runtime);

      invokeHandler(
        handlers,
        "agent_end",
        { type: "agent_end" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-a",
          },
        },
      );

      const first = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-a",
          },
        },
      );
      expect(first.message?.customType).toBe("roaster-memory-injection");

      const second = invokeHandler<unknown>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-a",
          },
        },
      );
      expect(second).toBeUndefined();

      const third = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-b",
          },
        },
      );
      expect(third.message?.customType).toBe("roaster-memory-injection");

      invokeHandler(
        handlers,
        "session_compact",
        { type: "session_compact" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-a",
          },
        },
      );

      const fourth = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-a",
          },
        },
      );
      expect(fourth.message?.customType).toBe("roaster-memory-injection");
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("commits supplemental budget only for emitted memory injections", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-commit-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-commit");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const commits: Array<{ sessionId: string; tokens: number; scopeId?: string }> = [];
      const runtime = withRuntimeConfig({
        getLedgerDigest: (sessionId: string) =>
          `[EvidenceDigest session=${sessionId}]\ncount=1 pass=1 fail=0 inconclusive=0\n- read(pass) src/a.ts`,
        planSupplementalContextInjection: (_sessionId: string, inputText: string) => ({
          accepted: true,
          text: inputText,
          originalTokens: 12,
          finalTokens: 12,
          truncated: false,
        }),
        commitSupplementalContextInjection: (sessionId: string, finalTokens: number, scopeId?: string) => {
          commits.push({ sessionId, tokens: finalTokens, scopeId });
        },
      } as any);

      registerMemory(api, runtime);

      invokeHandler(
        handlers,
        "agent_end",
        { type: "agent_end" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-a",
          },
        },
      );

      const first = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-a",
          },
        },
      );
      expect(first.message?.customType).toBe("roaster-memory-injection");
      expect(commits).toHaveLength(1);
      expect(commits[0]).toEqual({ sessionId: "session-b", tokens: 12, scopeId: "leaf-a" });

      const second = invokeHandler<unknown>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-a",
          },
        },
      );
      expect(second).toBeUndefined();
      expect(commits).toHaveLength(1);

      const third = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-b",
            getLeafId: () => "leaf-b",
          },
        },
      );
      expect(third.message?.customType).toBe("roaster-memory-injection");
      expect(commits).toHaveLength(2);
      expect(commits[1]).toEqual({ sessionId: "session-b", tokens: 12, scopeId: "leaf-b" });
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("clears memory dedup state on session shutdown", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-shutdown-reset-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-shutdown-reset");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        getLedgerDigest: (sessionId: string) =>
          `[EvidenceDigest session=${sessionId}]\ncount=1 pass=1 fail=0 inconclusive=0\n- read(pass) src/a.ts`,
      } as any);

      registerMemory(api, runtime);

      invokeHandler(
        handlers,
        "agent_end",
        { type: "agent_end" },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "session-a",
          },
        },
      );

      const beforeStartCtx = {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => "session-b",
          getLeafId: () => "leaf-a",
        },
      };

      const first = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        beforeStartCtx,
      );
      expect(first.message?.customType).toBe("roaster-memory-injection");

      const second = invokeHandler<unknown>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        beforeStartCtx,
      );
      expect(second).toBeUndefined();

      invokeHandler(
        handlers,
        "session_shutdown",
        { type: "session_shutdown" },
        {
          sessionManager: {
            getSessionId: () => "session-b",
          },
        },
      );

      const third = invokeHandler<{ message?: { customType?: string } }>(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base", prompt: "next" },
        beforeStartCtx,
      );
      expect(third.message?.customType).toBe("roaster-memory-injection");
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("uses handoff breaker fallback and recovers after cooldown", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-handoff-breaker-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-handoff-breaker");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const eventTypes: string[] = [];
      let digestCalls = 0;
      const runtime = withRuntimeConfig({
        config: {
          infrastructure: {
            interruptRecovery: {
              sessionHandoff: {
                enabled: true,
                maxSummaryChars: 600,
                circuitBreaker: {
                  enabled: true,
                  maxConsecutiveFailures: 1,
                  cooldownTurns: 2,
                },
              },
            },
          },
        },
        recordEvent: (input: { type: string }) => {
          eventTypes.push(input.type);
        },
        getLedgerDigest: (sessionId: string) => {
          digestCalls += 1;
          if (digestCalls === 1) {
            return "bad digest format";
          }
          return `[EvidenceDigest session=${sessionId}]\ncount=1 pass=1 fail=0 inconclusive=0\n- read(pass) src/a.ts`;
        },
      } as any);

      registerMemory(api, runtime);

      const sessionId = "session-handoff-breaker";
      const baseCtx = {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      };

      invokeHandler(handlers, "turn_start", { turnIndex: 1 }, baseCtx);
      invokeHandler(handlers, "agent_end", { type: "agent_end" }, baseCtx);

      const memoryFile = join(workspace, ".orchestrator/memory", `${sessionId}.json`);
      const firstMemory = JSON.parse(readFileSync(memoryFile, "utf8")) as { lastHandoff?: string };
      expect(firstMemory.lastHandoff?.includes("mode=fallback")).toBe(true);

      invokeHandler(handlers, "turn_start", { turnIndex: 2 }, baseCtx);
      invokeHandler(handlers, "agent_end", { type: "agent_end" }, baseCtx);

      const secondMemory = JSON.parse(readFileSync(memoryFile, "utf8")) as { lastHandoff?: string };
      expect(secondMemory.lastHandoff?.includes("mode=fallback")).toBe(true);

      invokeHandler(handlers, "turn_start", { turnIndex: 3 }, baseCtx);
      invokeHandler(handlers, "agent_end", { type: "agent_end" }, baseCtx);

      const thirdMemory = JSON.parse(readFileSync(memoryFile, "utf8")) as { lastHandoff?: string };
      expect(thirdMemory.lastHandoff?.includes("topTools=")).toBe(true);
      expect(thirdMemory.lastHandoff?.includes("mode=fallback")).toBe(false);

      expect(eventTypes.includes("session_handoff_breaker_opened")).toBe(true);
      expect(eventTypes.includes("session_handoff_skipped")).toBe(true);
      expect(eventTypes.includes("session_handoff_breaker_closed")).toBe(true);
      expect(eventTypes.includes("session_handoff_generated")).toBe(true);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("prioritizes goal-related artifacts in structured handoff", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-goal-rank-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-goal-rank");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const sessionId = "session-goal-rank";
      const runtime = withRuntimeConfig({
        config: {
          infrastructure: {
            interruptRecovery: {
              sessionHandoff: {
                enabled: true,
                maxSummaryChars: 1200,
                relevance: {
                  enabled: true,
                  goalWeight: 3,
                  failureWeight: 1,
                  recencyWeight: 0.1,
                  artifactWeight: 0.1,
                },
                circuitBreaker: {
                  enabled: true,
                  maxConsecutiveFailures: 2,
                  cooldownTurns: 2,
                },
              },
            },
          },
        },
        getLedgerDigest: (id: string) =>
          `[EvidenceDigest session=${id}]\ncount=3 pass=2 fail=1 inconclusive=0\n- edit(pass) docs/guide.md\n- edit(fail) src/payment/retry.ts\n- roaster_verify(pass) payment retry tests`,
        ledger: {
          query: () => [
            createLedgerRow({
              id: "ev-docs",
              timestamp: 1,
              tool: "edit",
              verdict: "pass",
              argsSummary: "docs/guide.md",
              outputSummary: "updated docs",
              sessionId,
            }),
            createLedgerRow({
              id: "ev-payment",
              timestamp: 2,
              tool: "edit",
              verdict: "fail",
              argsSummary: "src/payment/retry.ts",
              outputSummary: "retry path broken",
              sessionId,
            }),
            createLedgerRow({
              id: "ev-verify",
              timestamp: 3,
              tool: "roaster_verify",
              verdict: "pass",
              argsSummary: "payment retry tests",
              outputSummary: "ok",
              sessionId,
            }),
          ],
        },
      } as any);

      registerMemory(api, runtime);

      const context = {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      };

      invokeHandler(handlers, "turn_start", { turnIndex: 1 }, context);
      invokeHandler(
        handlers,
        "before_agent_start",
        { type: "before_agent_start", prompt: "fix payment retry failure", systemPrompt: "base" },
        context,
      );
      invokeHandler(handlers, "agent_end", { type: "agent_end" }, context);

      const memoryFile = join(workspace, ".orchestrator/memory", `${sessionId}.json`);
      const saved = JSON.parse(readFileSync(memoryFile, "utf8")) as { lastHandoff?: string };
      const handoff = saved.lastHandoff ?? "";
      const artifactsSection = /artifacts:\n- ([^\n]+)/.exec(handoff);
      expect(artifactsSection?.[1]).toContain("src/payment/retry.ts");
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("builds hierarchical user handoff memory and injects aggregated levels", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-hierarchy-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-hierarchy");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        config: {
          infrastructure: {
            interruptRecovery: {
              sessionHandoff: {
                enabled: true,
                maxSummaryChars: 1000,
                hierarchy: {
                  enabled: true,
                  branchFactor: 2,
                  maxLevels: 2,
                  entriesPerLevel: 2,
                  maxCharsPerEntry: 180,
                },
                circuitBreaker: {
                  enabled: true,
                  maxConsecutiveFailures: 2,
                  cooldownTurns: 2,
                },
              },
            },
          },
        },
        getLedgerDigest: (sessionId: string) =>
          `[EvidenceDigest session=${sessionId}]\ncount=1 pass=1 fail=0 inconclusive=0\n- edit(pass) src/${sessionId}.ts`,
      } as any);

      registerMemory(api, runtime);

      for (const sessionId of ["hier-a", "hier-b", "hier-c"]) {
        invokeHandler(
          handlers,
          "agent_end",
          { type: "agent_end" },
          {
            cwd: workspace,
            sessionManager: {
              getSessionId: () => sessionId,
            },
          },
        );
      }

      const userMemoryPath = join(dirname(agentDir), "memory", "user-preferences.json");
      const userMemory = JSON.parse(readFileSync(userMemoryPath, "utf8")) as {
        handoffHierarchy?: {
          levels?: string[][];
        };
      };
      expect(userMemory.handoffHierarchy?.levels?.[1]?.length).toBeGreaterThanOrEqual(1);
      expect(userMemory.handoffHierarchy?.levels?.[1]?.[0]?.includes("[HierarchyL1]")).toBe(true);

      const injected = invokeHandler<{
        message: {
          content: string;
        };
      }>(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          systemPrompt: "base",
          prompt: "continue",
        },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "hier-next",
          },
        },
      );

      expect(injected.message.content.includes("[UserMemoryHierarchy:L1]")).toBe(true);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("filters hierarchy injection by current goal terms", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-hierarchy-goal-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-hierarchy-goal");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const userMemoryFile = join(dirname(agentDir), "memory", "user-preferences.json");
      mkdirSync(dirname(userMemoryFile), { recursive: true });
      writeFileSync(
        userMemoryFile,
        JSON.stringify(
          {
            updatedAt: Date.now(),
            handoffHierarchy: {
              levels: [
                [
                  "artifacts: src/docs/guide.md (edit)",
                  "artifacts: src/payment/retry.ts (edit)",
                  "openFailures: roaster_verify payment retry tests",
                ],
                ["[HierarchyL1]\n- docs guide cleanup", "[HierarchyL1]\n- payment retry failure investigation"],
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        config: {
          infrastructure: {
            interruptRecovery: {
              sessionHandoff: {
                hierarchy: {
                  enabled: true,
                  branchFactor: 2,
                  maxLevels: 2,
                  entriesPerLevel: 2,
                  maxCharsPerEntry: 180,
                  goalFilterEnabled: true,
                  minGoalScore: 0.34,
                  maxInjectedEntries: 2,
                },
              },
            },
          },
        },
      } as any);

      registerMemory(api, runtime);

      const injected = invokeHandler<{
        message: {
          content: string;
        };
      }>(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          systemPrompt: "base",
          prompt: "fix payment retry failure",
        },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => "hier-goal-session",
          },
        },
      );

      const hierarchyBlock = /\[UserMemoryHierarchy:L[0-9]+\]\n([\s\S]*?)(?:\n\n|$)/.exec(injected.message.content)?.[0] ?? "";
      expect(hierarchyBlock.includes("payment retry")).toBe(true);
      expect(hierarchyBlock.includes("docs guide")).toBe(false);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("applies memory injection total budget and per-source caps", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-injection-budget-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-injection-budget");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const sessionId = "budget-session";
      const sessionMemoryDir = join(workspace, ".orchestrator", "memory");
      mkdirSync(sessionMemoryDir, { recursive: true });
      writeFileSync(
        join(sessionMemoryDir, `${sessionId}.json`),
        JSON.stringify(
          {
            sessionId,
            updatedAt: Date.now(),
            lastHandoff: `[SessionHandoff]\nSESSION-HANDOFF-KEY ${"x".repeat(600)}`,
            lastDigest: `SESSION-DIGEST-LOW ${"y".repeat(300)}`,
          },
          null,
          2,
        ),
        "utf8",
      );

      const userMemoryFile = join(dirname(agentDir), "memory", "user-preferences.json");
      mkdirSync(dirname(userMemoryFile), { recursive: true });
      writeFileSync(
        userMemoryFile,
        JSON.stringify(
          {
            updatedAt: Date.now(),
            preferences: `PREFS-KEY ${"p".repeat(200)}`,
            lastHandoff: `[SessionHandoff]\nUSER-HANDOFF-LOW ${"u".repeat(300)}`,
            lastDigest: `USER-DIGEST-LOW ${"d".repeat(280)}`,
            handoffHierarchy: {
              levels: [["payment retry hierarchy key", "docs hierarchy noise"]],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        config: {
          infrastructure: {
            interruptRecovery: {
              sessionHandoff: {
                hierarchy: {
                  enabled: true,
                  branchFactor: 2,
                  maxLevels: 1,
                  entriesPerLevel: 2,
                  maxCharsPerEntry: 120,
                  goalFilterEnabled: false,
                  minGoalScore: 0,
                  maxInjectedEntries: 2,
                },
                injectionBudget: {
                  enabled: true,
                  maxTotalChars: 340,
                  maxUserPreferencesChars: 80,
                  maxUserHandoffChars: 80,
                  maxHierarchyChars: 90,
                  maxUserDigestChars: 80,
                  maxSessionHandoffChars: 160,
                  maxSessionDigestChars: 80,
                },
              },
            },
          },
        },
      } as any);

      registerMemory(api, runtime);

      const injected = invokeHandler<{
        message: {
          content: string;
        };
      }>(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          systemPrompt: "base",
          prompt: "fix payment retry",
        },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => sessionId,
          },
        },
      );

      const content = injected.message.content;
      expect(content.length).toBeLessThanOrEqual(340);
      expect(content.includes("SESSION-HANDOFF-KEY")).toBe(true);
      expect(content.includes("[UserMemoryHierarchy:L0]")).toBe(true);
      expect(content.includes("USER-DIGEST-LOW")).toBe(false);
      expect(content.includes("SESSION-DIGEST-LOW")).toBe(false);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("does not apply injection caps when injectionBudget is disabled", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-memory-injection-budget-disabled-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-injection-budget-disabled");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const sessionId = "budget-disabled-session";
      const sessionMemoryDir = join(workspace, ".orchestrator", "memory");
      mkdirSync(sessionMemoryDir, { recursive: true });
      writeFileSync(
        join(sessionMemoryDir, `${sessionId}.json`),
        JSON.stringify(
          {
            sessionId,
            updatedAt: Date.now(),
            lastHandoff: `[SessionHandoff]\nSESSION-HANDOFF-RAW ${"x".repeat(420)}`,
            lastDigest: `SESSION-DIGEST-RAW ${"y".repeat(220)}`,
          },
          null,
          2,
        ),
        "utf8",
      );

      const userMemoryFile = join(dirname(agentDir), "memory", "user-preferences.json");
      mkdirSync(dirname(userMemoryFile), { recursive: true });
      writeFileSync(
        userMemoryFile,
        JSON.stringify(
          {
            updatedAt: Date.now(),
            preferences: `PREFS-RAW ${"p".repeat(220)}`,
            lastHandoff: `[SessionHandoff]\nUSER-HANDOFF-RAW ${"u".repeat(240)}`,
            lastDigest: `USER-DIGEST-RAW ${"d".repeat(240)}`,
            handoffHierarchy: {
              levels: [["hierarchy raw entry one", "hierarchy raw entry two"]],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const { api, handlers } = createMockExtensionAPI();
      const runtime = withRuntimeConfig({
        config: {
          infrastructure: {
            interruptRecovery: {
              sessionHandoff: {
                hierarchy: {
                  enabled: true,
                  branchFactor: 2,
                  maxLevels: 1,
                  entriesPerLevel: 2,
                  maxCharsPerEntry: 120,
                  goalFilterEnabled: false,
                  minGoalScore: 0,
                  maxInjectedEntries: 2,
                },
                injectionBudget: {
                  enabled: false,
                  maxTotalChars: 120,
                  maxUserPreferencesChars: 60,
                  maxUserHandoffChars: 60,
                  maxHierarchyChars: 60,
                  maxUserDigestChars: 60,
                  maxSessionHandoffChars: 60,
                  maxSessionDigestChars: 60,
                },
              },
            },
          },
        },
      } as any);

      registerMemory(api, runtime);

      const injected = invokeHandler<{
        message: {
          content: string;
        };
      }>(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          systemPrompt: "base",
          prompt: "fix payment retry",
        },
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => sessionId,
          },
        },
      );

      const content = injected.message.content;
      expect(content.includes("SESSION-HANDOFF-RAW")).toBe(true);
      expect(content.includes("SESSION-DIGEST-RAW")).toBe(true);
      expect(content.includes("USER-DIGEST-RAW")).toBe(true);
      expect(content.length).toBeGreaterThan(120);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });
});

describe("Extension gaps: event stream", () => {
  // Covered by "Extension integration: observability > persists throttled message_update events"
});

describe("Extension gaps: quality gate", () => {
  test("transforms input when sanitizeInput changes text", () => {
    const { api, handlers } = createMockExtensionAPI();

    const runtime = withRuntimeConfig({
      checkToolAccess: () => ({ allowed: true }),
      markToolCall: () => undefined,
      trackToolCallStart: () => undefined,
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
      checkToolAccess: () => ({ allowed: true }),
      markToolCall: () => undefined,
      trackToolCallStart: () => undefined,
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
});

describe("Extension gaps: ledger writer", () => {
  test("records tool_result with extracted text and fail verdict when isError=true", () => {
    const { api, handlers } = createMockExtensionAPI();

    const recorded: any[] = [];
    const ended: any[] = [];
    const runtime = withRuntimeConfig({
      recordToolResult: (input: any) => {
        recorded.push(input);
      },
      trackToolCallEnd: (input: any) => {
        ended.push(input);
      },
    } as any);

    registerLedgerWriter(api, runtime);

    invokeHandler(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-err",
        toolName: "bash",
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

    expect(recorded).toHaveLength(1);
    expect(recorded[0].sessionId).toBe("lw-1");
    expect(recorded[0].toolName).toBe("bash");
    expect(recorded[0].success).toBe(false);
    expect(recorded[0].verdict).toBe("fail");
    expect(recorded[0].outputText).toBe("line-a\nline-b");
    expect(recorded[0].metadata.toolCallId).toBe("tc-err");

    expect(ended).toHaveLength(1);
    expect(ended[0].success).toBe(false);
    expect(ended[0].toolCallId).toBe("tc-err");
  });
});

describe("Extension integration: observability", () => {
  test("emits both context and memory injections on before_agent_start via SDK runner contract", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-dual-injection-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });

    const agentDir = join(workspace, ".pi-agent-test-dual-injection");
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const extensionPath = join(workspace, "roaster-inline-extension.ts");
      const roasterExtensionEntry = join(process.cwd(), "packages/roaster-extensions/src/index.ts").replaceAll("\\", "/");
      writeFileSync(
        extensionPath,
        [
          `import { createRoasterExtension } from '${roasterExtensionEntry}';`,
          "export default createRoasterExtension({ registerTools: false });",
        ].join("\n"),
        "utf8",
      );

      const loaded = await discoverAndLoadExtensions([extensionPath], workspace, agentDir, createEventBus());
      expect(loaded.errors).toHaveLength(0);

      const sessionManager = SessionManager.inMemory(workspace);
      const modelRegistry = new ModelRegistry(
        new AuthStorage(join(workspace, ".auth-test.json")),
        join(workspace, ".models-test.json"),
      );
      const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, workspace, sessionManager, modelRegistry);

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

      const result = await runner.emitBeforeAgentStart("continue fixing flaky tests", undefined, "base");
      const messageTypes = (result?.messages ?? []).map((message) => message.customType);

      expect(result?.systemPrompt).toBeUndefined();
      expect(messageTypes).toEqual(["roaster-context-injection", "roaster-memory-injection"]);
    } finally {
      if (oldAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    }
  });

  test("tool call + tool result produces correlated events, ledger row, and patch record", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-obs-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/a.ts"), "export const value = 1;\n", "utf8");

    const runtime = new RoasterRuntime({ cwd: workspace });
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

    const snapshot = runtime.queryEvents(sessionId, { type: "file_snapshot_captured", last: 1 })[0];
    expect(snapshot).toBeDefined();
    const snapshotPayload = snapshot?.payload as { files?: string[] } | undefined;
    expect(snapshotPayload?.files).toContain("src/a.ts");

    const patchRecorded = runtime.queryEvents(sessionId, { type: "patch_recorded", last: 1 })[0];
    expect(patchRecorded).toBeDefined();
    const patchPayload = patchRecorded?.payload as { changes?: Array<{ path: string; action: string }> } | undefined;
    expect(patchPayload?.changes).toEqual([{ path: "src/a.ts", action: "modify" }]);

    const reloaded = new RoasterRuntime({ cwd: workspace });
    expect(reloaded.queryEvents(sessionId).length).toBeGreaterThan(0);
    expect(reloaded.ledger.list(sessionId)).toHaveLength(1);
  });

  test("blocked tool call is still observable as tool_call but not tool_call_marked", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-blocked-"));
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

    const runtime = new RoasterRuntime({ cwd: workspace });
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
    expect(runtime.queryEvents(sessionId, { type: "file_snapshot_captured", last: 1 })).toHaveLength(0);
  });

  test("persists throttled message_update events", () => {
    const workspace = mkdtempSync(join(tmpdir(), "roaster-ext-throttle-"));
    const runtime = new RoasterRuntime({ cwd: workspace });
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
      invokeHandlers(handlers, "message_start", { message: { role: "assistant", content: [] } }, ctx);

      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "a" }] },
          assistantMessageEvent: { type: "text_delta" },
        },
        ctx,
      );
      now += 100;
      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
          assistantMessageEvent: { type: "text_delta" },
        },
        ctx,
      );
      now += 300;
      invokeHandlers(
        handlers,
        "message_update",
        {
          message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
          assistantMessageEvent: { type: "text_delta" },
        },
        ctx,
      );
    } finally {
      Date.now = originalNow;
    }

    const updates = runtime.queryEvents(sessionId, { type: "message_update" });
    expect(updates.length).toBe(2);
  });
});
