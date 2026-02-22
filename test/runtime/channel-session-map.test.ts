import { describe, expect, test } from "bun:test";
import {
  buildChannelDedupeKey,
  buildChannelSessionId,
  buildRawConversationKey,
} from "../../packages/brewva-runtime/src/channels/session-map.js";

describe("channel session mapping", () => {
  test("buildRawConversationKey normalizes channel and preserves conversation id", () => {
    expect(buildRawConversationKey(" Telegram ", " 12345 ")).toBe("telegram:12345");
    expect(buildRawConversationKey("tg", "group:42")).toBe("telegram:group:42");
  });

  test("buildChannelSessionId is deterministic and scoped by channel", () => {
    const first = buildChannelSessionId("telegram", "12345");
    const second = buildChannelSessionId(" telegram ", "12345");
    const otherChannel = buildChannelSessionId("discord", "12345");

    expect(first).toBe(second);
    expect(first).not.toBe(otherChannel);
    expect(first.startsWith("channel:")).toBe(true);
    expect(first.length).toBe(48);
  });

  test("buildChannelDedupeKey composes channel, conversation, and message id", () => {
    expect(buildChannelDedupeKey("telegram", "12345", "9001")).toBe("telegram:12345:9001");
  });

  test("throws on empty tokens", () => {
    expect(() => buildChannelSessionId("", "abc")).toThrow("channel is required");
    expect(() => buildChannelSessionId("telegram", " ")).toThrow("conversationId is required");
    expect(() => buildChannelDedupeKey("telegram", "abc", "")).toThrow("messageId is required");
  });
});
