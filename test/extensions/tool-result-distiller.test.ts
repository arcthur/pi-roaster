import { describe, expect, test } from "bun:test";
import {
  registerLedgerWriter,
  registerToolResultDistiller,
} from "@brewva/brewva-gateway/runtime-plugins";
import { createMockExtensionAPI } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function invokeToolResultMiddleware(
  handlers: ReturnType<typeof createMockExtensionAPI>["handlers"],
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): {
  currentEvent: Record<string, unknown>;
  results: unknown[];
} {
  const list = handlers.get("tool_result") ?? [];
  const currentEvent = { ...event };
  const results: unknown[] = [];

  for (const handler of list) {
    const result = handler(currentEvent, ctx);
    results.push(result);
    if (!result || typeof result !== "object") continue;
    const patch = result as Record<string, unknown>;
    if (patch.content !== undefined) {
      currentEvent.content = patch.content;
    }
    if (patch.details !== undefined) {
      currentEvent.details = patch.details;
    }
    if (patch.isError !== undefined) {
      currentEvent.isError = patch.isError;
    }
  }

  return { currentEvent, results };
}

describe("tool result inline distiller", () => {
  test("distills current-turn exec output after raw evidence is recorded", () => {
    const { api, handlers } = createMockExtensionAPI();
    const finished: Array<Record<string, unknown>> = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: Record<string, unknown>) => {
          finished.push(input);
        },
      },
    });

    registerLedgerWriter(api, runtime);
    registerToolResultDistiller(api, runtime);

    const output = Array.from({ length: 220 }, (_value, index) =>
      index % 17 === 0 ? `error: failed at step ${index}` : `trace line ${index}`,
    ).join("\n");
    const { results } = invokeToolResultMiddleware(
      handlers,
      {
        toolCallId: "tc-inline-distill",
        toolName: "exec",
        input: { command: "npm test" },
        isError: true,
        content: [{ type: "text", text: output }],
        details: { durationMs: 1200 },
      },
      {
        sessionManager: {
          getSessionId: () => "distill-1",
        },
      },
    );

    expect(finished).toHaveLength(1);
    expect(String(finished[0]?.outputText)).toContain("trace line 219");
    expect(String(finished[0]?.outputText)).toContain("error: failed at step 204");
    expect(results[0]).toBeUndefined();
    expect(results[1]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("[ExecDistilled]") }],
    });
  });

  test("skips inline distillation for mixed-content tool results", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();

    registerToolResultDistiller(api, runtime);

    const { currentEvent, results } = invokeToolResultMiddleware(
      handlers,
      {
        toolCallId: "tc-mixed",
        toolName: "exec",
        input: { command: "npm test" },
        isError: false,
        content: [
          { type: "text", text: "plain text" },
          { type: "image", imageUrl: "artifact://image" },
        ],
        details: undefined,
      },
      {
        sessionManager: {
          getSessionId: () => "distill-2",
        },
      },
    );

    expect(results).toEqual([undefined]);
    expect(currentEvent.content).toEqual([
      { type: "text", text: "plain text" },
      { type: "image", imageUrl: "artifact://image" },
    ]);
  });
});
