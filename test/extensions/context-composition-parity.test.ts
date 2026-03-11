import { describe, expect, test } from "bun:test";
import {
  registerContextTransform,
  registerRuntimeCoreBridge,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  createMockExtensionAPI,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
} from "../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

describe("context composition parity", () => {
  test("keeps gate-clearing semantics aligned between full extensions and runtime-core profile", async () => {
    const config = createRuntimeConfig((draft) => {
      draft.infrastructure.contextBudget.hardLimitPercent = 0.8;
    });

    const makeRuntime = () =>
      createRuntimeFixture({
        config,
        context: {
          buildInjection: async () => ({
            text: "",
            entries: [],
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          }),
        },
      });

    const sessionManager = { getSessionId: () => "parity-clear" };

    const fullRuntime = makeRuntime();
    const full = createMockExtensionAPI();
    registerContextTransform(full.api, fullRuntime);
    await invokeHandlerAsync(
      full.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "arm", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );
    invokeHandler(
      full.handlers,
      "session_compact",
      {
        compactionEntry: { id: "cmp-full", summary: "clear gate" },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );
    const fullAfter = await invokeHandlerAsync<{ message?: { content?: string } }>(
      full.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "after compact", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );

    const coreRuntime = makeRuntime();
    const core = createMockExtensionAPI();
    registerRuntimeCoreBridge(core.api, coreRuntime);
    await invokeHandlerAsync(
      core.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "arm", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );
    invokeHandler(
      core.handlers,
      "session_compact",
      {
        compactionEntry: { id: "cmp-core", summary: "clear gate" },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );
    const coreResults = await invokeHandlersAsync<{ message?: { content?: string } }>(
      core.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "after compact", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );
    const coreAfter = coreResults.find(
      (value): value is { message: { content: string } } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { message?: { content?: unknown } }).message?.content === "string",
    );

    expect(fullRuntime.context.getCompactionGateStatus("parity-clear").required).toBe(false);
    expect(coreRuntime.context.getCompactionGateStatus("parity-clear").required).toBe(false);
    expect(fullAfter.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(coreAfter?.message.content.includes("[ContextCompactionGate]")).toBe(false);
    expect(coreAfter?.message.content.includes("[OperationalDiagnostics]")).toBe(false);
  });
});
