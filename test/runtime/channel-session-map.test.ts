import { describe, expect, test } from "bun:test";
import {
  buildChannelDedupeKey,
  buildChannelSessionId,
  buildRawConversationKey,
} from "@brewva/brewva-runtime/channels";

describe("channel session mapping", () => {
  test("given raw channel and conversation id, when building raw conversation key, then channel is normalized and conversation id is preserved", () => {
    expect(buildRawConversationKey(" Telegram ", " 12345 ")).toBe("telegram:12345");
    expect(buildRawConversationKey("tg", "group:42")).toBe("telegram:group:42");
  });

  test("given same conversation and normalized channel, when building channel session id, then id is deterministic and channel-scoped", () => {
    const first = buildChannelSessionId("telegram", "12345");
    const second = buildChannelSessionId(" telegram ", "12345");
    const otherChannel = buildChannelSessionId("discord", "12345");

    expect(first).toBe(second);
    expect(first).not.toBe(otherChannel);
    expect(first.startsWith("channel:")).toBe(true);
    expect(first.length).toBe(48);
  });

  test("given channel conversation and message id, when building dedupe key, then key contains all tokens", () => {
    expect(buildChannelDedupeKey("telegram", "12345", "9001")).toBe("telegram:12345:9001");
  });

  test("given empty required tokens, when building session or dedupe key, then function throws validation error", () => {
    expect(() => buildChannelSessionId("", "abc")).toThrow("channel is required");
    expect(() => buildChannelSessionId("telegram", " ")).toThrow("conversationId is required");
    expect(() => buildChannelDedupeKey("telegram", "abc", "")).toThrow("messageId is required");
  });
});
