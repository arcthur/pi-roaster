import { describe, expect, test } from "bun:test";
import {
  prepareTurnForDelivery,
  resolveTurnDeliveryPlan,
  type ChannelCapabilities,
  type TurnEnvelope,
} from "@brewva/brewva-runtime/channels";

const BASE_TURN: TurnEnvelope = {
  schema: "brewva.turn.v1",
  kind: "assistant",
  sessionId: "channel:session",
  turnId: "t1",
  channel: "telegram",
  conversationId: "12345",
  timestamp: 1_700_000_000_000,
  parts: [{ type: "text", text: "hello" }],
};

describe("channel output policy", () => {
  test("resolves delivery plan from capabilities", () => {
    const caps: ChannelCapabilities = {
      streaming: true,
      inlineActions: false,
      codeBlocks: false,
      multiModal: false,
      threadedReplies: true,
    };
    const plan = resolveTurnDeliveryPlan(BASE_TURN, caps);
    expect(plan).toEqual({
      streamMode: "stream",
      approvalMode: "none",
      codeBlockMode: "plain_text",
      mediaMode: "link_only",
      threadMode: "native",
    });
  });

  test("downgrades approval, media, code blocks, and threading when unsupported", () => {
    const turn: TurnEnvelope = {
      ...BASE_TURN,
      kind: "approval",
      threadId: "777",
      parts: [
        { type: "text", text: "```ts\nconst x = 1;\n```" },
        { type: "image", uri: "https://example.com/a.png" },
        { type: "file", uri: "https://example.com/b.txt", name: "b.txt" },
      ],
      approval: {
        requestId: "req-1",
        title: "Need approval",
        detail: "run command?",
        actions: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    };
    const caps: ChannelCapabilities = {
      streaming: false,
      inlineActions: false,
      codeBlocks: false,
      multiModal: false,
      threadedReplies: false,
    };

    const prepared = prepareTurnForDelivery(turn, caps);
    const textParts = prepared.parts.filter((part) => part.type === "text");
    expect(textParts.length).toBe(4);
    expect(textParts[0]).toEqual({
      type: "text",
      text: "[thread:777]\nconst x = 1;",
    });
    expect(textParts[1]).toEqual({
      type: "text",
      text: "[image] https://example.com/a.png",
    });
    expect(textParts[2]).toEqual({
      type: "text",
      text: "[file (b.txt)] https://example.com/b.txt",
    });
    expect((textParts[3] as { text: string }).text.includes("Reply with one of:")).toBe(true);
    expect(prepared.meta?.deliveryPlan).toEqual({
      streamMode: "buffered",
      approvalMode: "text",
      codeBlockMode: "plain_text",
      mediaMode: "link_only",
      threadMode: "prepend_context",
    });
  });

  test("preserves multimodal and inline approval when supported", () => {
    const turn: TurnEnvelope = {
      ...BASE_TURN,
      kind: "approval",
      threadId: "777",
      parts: [{ type: "image", uri: "https://example.com/a.png" }],
      approval: {
        requestId: "req-1",
        title: "Need approval",
        actions: [{ id: "approve", label: "Approve" }],
      },
    };
    const caps: ChannelCapabilities = {
      streaming: true,
      inlineActions: true,
      codeBlocks: true,
      multiModal: true,
      threadedReplies: true,
    };
    const prepared = prepareTurnForDelivery(turn, caps);
    expect(prepared.parts).toEqual([{ type: "image", uri: "https://example.com/a.png" }]);
    expect(prepared.meta?.deliveryPlan).toEqual({
      streamMode: "stream",
      approvalMode: "inline",
      codeBlockMode: "native",
      mediaMode: "native",
      threadMode: "native",
    });
  });
});
