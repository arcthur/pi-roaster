import { describe, expect, test } from "bun:test";
import { buildAgentScopedConversationKey, buildRoutingScopeKey } from "@brewva/brewva-cli";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

function createTurn(input: Partial<TurnEnvelope> = {}): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    channel: "telegram",
    conversationId: "123",
    timestamp: Date.now(),
    parts: [{ type: "text", text: "hello" }],
    ...input,
  };
}

describe("channel routing scope", () => {
  test("builds chat scoped key by default", () => {
    const key = buildRoutingScopeKey(createTurn(), "chat");
    expect(key).toBe("telegram:123");
  });

  test("builds thread scoped key when enabled", () => {
    const keyWithThread = buildRoutingScopeKey(createTurn({ threadId: "42" }), "thread");
    const keyWithoutThread = buildRoutingScopeKey(createTurn(), "thread");
    expect(keyWithThread).toBe("telegram:123:thread:42");
    expect(keyWithoutThread).toBe("telegram:123:thread:root");
  });

  test("builds agent scoped conversation key", () => {
    expect(buildAgentScopedConversationKey("jack", "telegram:123")).toBe("agent:jack:telegram:123");
  });
});
