import { describe, expect, test } from "bun:test";
import { registerMemoryBridge } from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("Extension gaps: memory bridge", () => {
  test("given agent_end then session_shutdown, when memory bridge handles hooks, then refresh and clear are invoked", () => {
    const { api, handlers } = createMockExtensionAPI();
    const calls: Array<{ kind: "refresh" | "clear"; sessionId: string }> = [];
    const runtime = createRuntimeFixture({
      memory: {
        refreshIfNeeded: ({ sessionId }: { sessionId: string }) => {
          calls.push({ kind: "refresh", sessionId });
          return undefined;
        },
        clearSessionCache: (sessionId: string) => {
          calls.push({ kind: "clear", sessionId });
        },
      },
    });

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
