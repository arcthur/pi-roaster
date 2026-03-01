import { describe, expect, test } from "bun:test";
import { registerContextTransform, registerRuntimeCoreBridge } from "@brewva/brewva-extensions";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createMockExtensionAPI, invokeHandler, invokeHandlerAsync } from "../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

type StatusBlock = {
  requiredAction: string;
  reason: string;
  recentCompaction: string;
  turnsSinceCompaction: string;
  windowTurns: string;
};

function parseStatusBlock(
  content: string,
  header: "[TapeStatus]" | "[CoreTapeStatus]",
): StatusBlock {
  const lines = content.split("\n");
  const begin = lines.findIndex((line) => line.trim() === header);
  if (begin < 0) {
    throw new Error(`missing status header: ${header}`);
  }

  const values = new Map<string, string>();
  for (let index = begin + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    if (line.startsWith("[")) break;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values.set(key, value);
  }

  return {
    requiredAction: values.get("required_action") ?? "",
    reason: values.get("compaction_gate_reason") ?? "",
    recentCompaction: values.get("recent_compact_performed") ?? "",
    turnsSinceCompaction: values.get("turns_since_compaction") ?? "",
    windowTurns: values.get("recent_compaction_window_turns") ?? "",
  };
}

async function collectExtensionStatus(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  usage: { tokens: number; contextWindow: number; percent: number };
}): Promise<StatusBlock> {
  const { api, handlers } = createMockExtensionAPI();
  registerContextTransform(api, input.runtime);
  const result = await invokeHandlerAsync<{ message?: { content?: string } }>(
    handlers,
    "before_agent_start",
    {
      type: "before_agent_start",
      prompt: "check parity",
      systemPrompt: "base",
    },
    {
      sessionManager: {
        getSessionId: () => input.sessionId,
      },
      getContextUsage: () => input.usage,
    },
  );
  return parseStatusBlock(result.message?.content ?? "", "[TapeStatus]");
}

async function collectCoreStatus(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  usage: { tokens: number; contextWindow: number; percent: number };
}): Promise<StatusBlock> {
  const { api, handlers } = createMockExtensionAPI();
  registerRuntimeCoreBridge(api, input.runtime);
  const result = await invokeHandlerAsync<{ message?: { content?: string } }>(
    handlers,
    "before_agent_start",
    {
      type: "before_agent_start",
      prompt: "check parity",
      systemPrompt: "base",
    },
    {
      sessionManager: {
        getSessionId: () => input.sessionId,
      },
      getContextUsage: () => input.usage,
    },
  );
  return parseStatusBlock(result.message?.content ?? "", "[CoreTapeStatus]");
}

describe("context gate parity", () => {
  test("keeps extension and runtime-core gate status aligned for floor_unmet re-arm", async () => {
    const makeRuntime = () => {
      let runtime = null as unknown as BrewvaRuntime;
      runtime = createRuntimeFixture({
        context: {
          buildInjection: async (sessionId: string) => {
            runtime.context.requestCompaction(sessionId, "floor_unmet");
            return {
              text: "",
              accepted: false,
              originalTokens: 0,
              finalTokens: 0,
              truncated: false,
            };
          },
        },
      });
      return runtime;
    };

    const sessionId = "parity-floor-unmet";
    const usage = { tokens: 300, contextWindow: 1000, percent: 0.3 };

    const extensionStatus = await collectExtensionStatus({
      runtime: makeRuntime(),
      sessionId,
      usage,
    });
    const coreStatus = await collectCoreStatus({
      runtime: makeRuntime(),
      sessionId,
      usage,
    });

    expect(extensionStatus).toEqual(coreStatus);
    expect(extensionStatus.requiredAction).toBe("session_compact_now");
    expect(extensionStatus.reason).toBe("floor_unmet");
  });

  test("keeps extension and runtime-core gate status aligned after session_compact clears gate", async () => {
    const config = createRuntimeConfig((draft) => {
      draft.infrastructure.contextBudget.hardLimitPercent = 0.8;
    });

    const makeRuntime = () =>
      createRuntimeFixture({
        config,
        context: {
          buildInjection: async () => ({
            text: "",
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          }),
        },
      });

    const runExtensionFlow = async (): Promise<StatusBlock> => {
      const runtime = makeRuntime();
      const { api, handlers } = createMockExtensionAPI();
      registerContextTransform(api, runtime);
      const sessionManager = { getSessionId: () => "parity-clear" };

      await invokeHandlerAsync(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          prompt: "arm",
          systemPrompt: "base",
        },
        {
          sessionManager,
          getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
        },
      );

      invokeHandler(
        handlers,
        "session_compact",
        {
          compactionEntry: {
            id: "cmp-clear-ext",
            summary: "clear gate",
          },
        },
        {
          sessionManager,
          getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
        },
      );

      const after = await invokeHandlerAsync<{ message?: { content?: string } }>(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          prompt: "after compact",
          systemPrompt: "base",
        },
        {
          sessionManager,
          getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
        },
      );
      return parseStatusBlock(after.message?.content ?? "", "[TapeStatus]");
    };

    const runCoreFlow = async (): Promise<StatusBlock> => {
      const runtime = makeRuntime();
      const { api, handlers } = createMockExtensionAPI();
      registerRuntimeCoreBridge(api, runtime);
      const sessionManager = { getSessionId: () => "parity-clear" };

      await invokeHandlerAsync(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          prompt: "arm",
          systemPrompt: "base",
        },
        {
          sessionManager,
          getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
        },
      );

      invokeHandler(
        handlers,
        "session_compact",
        {
          compactionEntry: {
            id: "cmp-clear-core",
            summary: "clear gate",
          },
        },
        {
          sessionManager,
          getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
        },
      );

      const after = await invokeHandlerAsync<{ message?: { content?: string } }>(
        handlers,
        "before_agent_start",
        {
          type: "before_agent_start",
          prompt: "after compact",
          systemPrompt: "base",
        },
        {
          sessionManager,
          getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
        },
      );
      return parseStatusBlock(after.message?.content ?? "", "[CoreTapeStatus]");
    };

    const extensionStatus = await runExtensionFlow();
    const coreStatus = await runCoreFlow();

    expect(extensionStatus).toEqual(coreStatus);
    expect(extensionStatus.requiredAction).toBe("none");
    expect(extensionStatus.reason).toBe("none");
  });
});
