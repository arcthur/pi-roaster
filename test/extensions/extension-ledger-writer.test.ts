import { describe, expect, test } from "bun:test";
import { registerLedgerWriter } from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("Extension gaps: ledger writer", () => {
  test("given error tool_result with mixed content, when ledger writer runs, then text is extracted and verdict is fail", () => {
    const { api, handlers } = createMockExtensionAPI();

    const finished: any[] = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: any) => {
          finished.push(input);
        },
      },
    });

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
