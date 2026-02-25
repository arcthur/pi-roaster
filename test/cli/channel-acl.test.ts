import { describe, expect, test } from "bun:test";
import { isOwnerAuthorized } from "@brewva/brewva-cli";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

function createTurn(meta: Record<string, unknown> = {}): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    channel: "telegram",
    conversationId: "123",
    timestamp: Date.now(),
    parts: [{ type: "text", text: "hello" }],
    meta,
  };
}

describe("channel orchestration ACL", () => {
  test("allows all when owners is empty and mode is open", () => {
    expect(isOwnerAuthorized(createTurn(), [], "open")).toBe(true);
  });

  test("denies all when owners is empty and mode is closed", () => {
    expect(isOwnerAuthorized(createTurn(), [], "closed")).toBe(false);
  });

  test("matches senderId", () => {
    expect(isOwnerAuthorized(createTurn({ senderId: "123" }), ["123"], "closed")).toBe(true);
    expect(isOwnerAuthorized(createTurn({ senderId: 123 }), ["123"], "closed")).toBe(true);
    expect(isOwnerAuthorized(createTurn({ senderId: "124" }), ["123"], "closed")).toBe(false);
  });

  test("matches senderUsername (case-insensitive, with or without @)", () => {
    const turn = createTurn({ senderUsername: "@Arthur" });
    expect(isOwnerAuthorized(turn, ["arthur"], "closed")).toBe(true);
    expect(isOwnerAuthorized(turn, ["@arthur"], "closed")).toBe(true);
    expect(isOwnerAuthorized(turn, ["@Arthur"], "closed")).toBe(true);
    expect(isOwnerAuthorized(turn, ["someoneelse"], "closed")).toBe(false);
  });

  test("denies when no sender identity is present and owners is configured", () => {
    expect(isOwnerAuthorized(createTurn(), ["123"], "open")).toBe(false);
    expect(isOwnerAuthorized(createTurn(), ["@arthur"], "open")).toBe(false);
  });
});
