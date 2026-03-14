import { describe, expect, test } from "bun:test";
import { registerQualityGate } from "@brewva/brewva-gateway/runtime-plugins";
import { createMockExtensionAPI, invokeHandler } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("Extension gaps: quality gate", () => {
  test("given sanitizer output differs, when input hook runs, then extension returns transform action", () => {
    const { api, handlers } = createMockExtensionAPI();
    const userInputs: string[] = [];

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        onUserInput: (sessionId: string) => {
          userInputs.push(sessionId);
        },
        sanitizeInput: (text: string) => `sanitized:${text}`,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string; text?: string; images?: unknown[] }>(
      handlers,
      "input",
      {
        source: "user",
        text: "hello",
        images: [{ type: "image", url: "test://image" }],
      },
      { sessionManager: { getSessionId: () => "quality-input-1" } },
    );

    expect(result.action).toBe("transform");
    expect(result.text).toBe("sanitized:hello");
    expect(result.images).toHaveLength(1);
    expect(userInputs).toEqual(["quality-input-1"]);
  });

  test("given sanitizer output unchanged, when input hook runs, then extension returns continue action", () => {
    const { api, handlers } = createMockExtensionAPI();
    const userInputs: string[] = [];

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        onUserInput: (sessionId: string) => {
          userInputs.push(sessionId);
        },
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string }>(
      handlers,
      "input",
      {
        source: "user",
        text: "hello",
        images: [],
      },
      { sessionManager: { getSessionId: () => "quality-input-2" } },
    );

    expect(result.action).toBe("continue");
    expect(userInputs).toEqual(["quality-input-2"]);
  });

  test("given non-ascii input unchanged by sanitizer, when input hook runs, then extension continues", () => {
    const { api, handlers, sentMessages } = createMockExtensionAPI();
    const userInputs: string[] = [];

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
        onUserInput: (sessionId: string) => {
          userInputs.push(sessionId);
        },
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    const result = invokeHandler<{ action: string }>(
      handlers,
      "input",
      {
        source: "interactive",
        text: "请 review this change",
        images: [],
      },
      { sessionManager: { getSessionId: () => "quality-input-3" } },
    );

    expect(result.action).toBe("continue");
    expect(sentMessages).toHaveLength(0);
    expect(userInputs).toEqual(["quality-input-3"]);
  });

  test("given tool_call and context usage, when quality gate runs, then runtime.tools.start receives normalized usage", () => {
    const { api, handlers } = createMockExtensionAPI();
    const calls: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        start: (input: any) => {
          calls.push(input);
          return { allowed: true };
        },
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });

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

  test("given runtime.tools.start denial, when tool_call hook runs, then extension blocks call with reason", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({
          allowed: false,
          reason: "blocked-by-runtime",
        }),
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });

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

  test("given allowed tool_call with advisory, when tool_result hook runs, then advisory is injected into the same turn", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({
          allowed: true,
          advisory:
            "[ExplorationAdvisory]\nSummarize what you know, then switch strategy before broadening the scan.",
        }),
      },
      context: {
        sanitizeInput: (text: string) => text,
      },
    });

    registerQualityGate(api, runtime);

    invokeHandler(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-advisory",
        toolName: "look_at",
        input: { goal: "inspect runtime" },
      },
      {
        sessionManager: { getSessionId: () => "qg-3" },
        getContextUsage: () => ({ tokens: 120, contextWindow: 4096, percent: 0.03 }),
      },
    );

    const result = invokeHandler<{ content?: Array<{ text?: string }> }>(
      handlers,
      "tool_result",
      {
        toolCallId: "tc-advisory",
        toolName: "look_at",
        input: { goal: "inspect runtime" },
        isError: false,
        content: [{ type: "text", text: "original result" }],
      },
      {
        sessionManager: { getSessionId: () => "qg-3" },
      },
    );

    expect(result.content?.[0]?.text).toContain("[ExplorationAdvisory]");
    expect(result.content?.[1]?.text).toBe("original result");
  });
});
