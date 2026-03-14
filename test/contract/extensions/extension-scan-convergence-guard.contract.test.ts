import { describe, expect, test } from "bun:test";
import {
  registerEventStream,
  registerLedgerWriter,
  registerQualityGate,
} from "@brewva/brewva-gateway/runtime-plugins";
import { createMockExtensionAPI, invokeHandler, invokeHandlers } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createContext(sessionId: string, cwd = "/tmp/brewva-scan-guard") {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    getContextUsage: () => ({ tokens: 120, contextWindow: 4096, percent: 0.03 }),
  };
}

function completeToolTurn(input: {
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >;
  ctx: Record<string, unknown>;
  turnIndex: number;
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  outputText?: string;
}): unknown[] {
  const results = invokeHandlers(
    input.handlers,
    "tool_call",
    {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
    },
    input.ctx,
    { stopOnBlock: true },
  );
  const blocked = results.some(
    (result) =>
      result && typeof result === "object" && (result as { block?: boolean }).block === true,
  );
  if (!blocked) {
    invokeHandler(
      input.handlers,
      "tool_result",
      {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input,
        isError: input.isError === true,
        content: [
          {
            type: "text",
            text: input.outputText ?? `${input.toolName} output`,
          },
        ],
      },
      input.ctx,
    );
  }
  invokeHandlers(
    input.handlers,
    "turn_end",
    {
      turnIndex: input.turnIndex,
      message: { role: "assistant", content: [] },
      toolResults: blocked ? [] : [{}],
    },
    input.ctx,
  );
  return results;
}

describe("event stream turn-end bridge", () => {
  test("forwards turn_end into runtime context lifecycle", () => {
    const { api, handlers } = createMockExtensionAPI();
    const turnEnds: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnEnd: (sessionId: string) => {
          turnEnds.push(sessionId);
        },
      },
    });

    registerEventStream(api, runtime);
    invokeHandlers(
      handlers,
      "turn_end",
      {
        turnIndex: 3,
        message: { role: "assistant", content: [] },
        toolResults: [],
      },
      createContext("scan-bridge-turn-end"),
    );

    expect(turnEnds).toEqual(["scan-bridge-turn-end"]);
  });

  test("delegates scan-only advisory handling to runtime after repeated low-signal turns", () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockExtensionAPI();
    const sessionId = "scan-bridge-runtime-1";
    const ctx = createContext(sessionId, runtime.cwd);

    registerEventStream(api, runtime);
    registerQualityGate(api, runtime);
    registerLedgerWriter(api, runtime);

    runtime.context.onUserInput(sessionId);

    for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
      runtime.context.onTurnStart(sessionId, turnIndex);
      completeToolTurn({
        handlers,
        ctx,
        turnIndex,
        toolCallId: `tc-read-${turnIndex}`,
        toolName: "read",
        input: { file_path: `src/file-${turnIndex}.ts` },
        outputText: "line 1\nline 2",
      });
    }

    expect(
      runtime.task
        .getState(sessionId)
        .blockers.find((entry) => entry.id === "guard:scan-convergence"),
    ).toBeUndefined();

    runtime.context.onTurnStart(sessionId, 4);
    const results = completeToolTurn({
      handlers,
      ctx,
      turnIndex: 4,
      toolCallId: "tc-look-at-advised",
      toolName: "look_at",
      input: { goal: "find the runtime facade" },
    });

    expect(results.some((result) => (result as { block?: boolean })?.block === true)).toBe(false);
    const advisoryEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_advisory",
      last: 1,
    })[0];
    expect(advisoryEvent?.payload?.toolStrategy).toBe("low_signal");
  });
});
