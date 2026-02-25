import { describe, expect, test } from "bun:test";
import { registerQualityGate } from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("Extension gaps: quality gate", () => {
  test("given sanitizer output differs, when input hook runs, then extension returns transform action", () => {
    const { api, handlers } = createMockExtensionAPI();

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
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
      {},
    );

    expect(result.action).toBe("transform");
    expect(result.text).toBe("sanitized:hello");
    expect(result.images).toHaveLength(1);
  });

  test("given sanitizer output unchanged, when input hook runs, then extension returns continue action", () => {
    const { api, handlers } = createMockExtensionAPI();

    const runtime = createRuntimeFixture({
      tools: {
        start: () => ({ allowed: true }),
      },
      context: {
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
      {},
    );

    expect(result.action).toBe("continue");
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
});
