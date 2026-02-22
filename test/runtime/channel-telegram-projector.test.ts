import { describe, expect, test } from "bun:test";
import { decodeTelegramApprovalCallback } from "../../packages/brewva-channels-telegram/src/approval-callback.js";
import {
  buildTelegramInboundDedupeKey,
  projectTelegramUpdateToTurn,
  renderTurnToTelegramRequests,
} from "../../packages/brewva-channels-telegram/src/projector.js";
import type { TelegramUpdate } from "../../packages/brewva-channels-telegram/src/types.js";
import { buildChannelSessionId } from "../../packages/brewva-runtime/src/channels/session-map.js";
import type { TurnEnvelope } from "../../packages/brewva-runtime/src/channels/turn.js";

describe("channel telegram projector", () => {
  test("projects Telegram message update to user turn", () => {
    const update: TelegramUpdate = {
      update_id: 42,
      message: {
        message_id: 7,
        date: 1_700_000_001,
        chat: { id: 12345, type: "private" },
        from: {
          id: 99,
          is_bot: false,
          first_name: "Ada",
          username: "ada",
        },
        text: "hello world",
        message_thread_id: 11,
      },
    };

    const turn = projectTelegramUpdateToTurn(update, {
      now: () => 1_700_000_999_000,
    });

    expect(turn).toEqual({
      schema: "brewva.turn.v1",
      kind: "user",
      sessionId: buildChannelSessionId("telegram", "12345"),
      turnId: "tg:message:12345:7",
      channel: "telegram",
      conversationId: "12345",
      messageId: "7",
      threadId: "11",
      timestamp: 1_700_000_001_000,
      parts: [{ type: "text", text: "hello world" }],
      meta: {
        updateId: 42,
        chatType: "private",
        senderId: "99",
        senderName: "Ada",
        senderUsername: "ada",
        edited: false,
      },
    });
  });

  test("projects callback query to approval turn when signature is valid", () => {
    const secret = "callback-secret";
    const approvalTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: "channel:session",
      turnId: "turn-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [],
      approval: {
        requestId: "req-1234567890",
        title: "Approve command?",
        actions: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    };

    const requests = renderTurnToTelegramRequests(approvalTurn, {
      inlineApproval: true,
      callbackSecret: secret,
    });
    expect(requests).toHaveLength(1);

    const callbackData = (
      (
        requests[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    const decoded = decodeTelegramApprovalCallback(callbackData, secret, { context: "12345" });
    expect(decoded).toEqual({
      requestId: "req-1234567890",
      actionId: "approve",
    });

    const update: TelegramUpdate = {
      update_id: 43,
      callback_query: {
        id: "cbq-1",
        from: { id: 99, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 100,
          date: 1_700_000_002,
          chat: { id: 12345, type: "private" },
        },
        data: callbackData,
      },
    };

    const turn = projectTelegramUpdateToTurn(update, {
      callbackSecret: secret,
    });
    expect(turn?.kind).toBe("approval");
    expect(turn?.approval?.requestId).toBe("req-1234567890");
    expect(turn?.meta?.decisionActionId).toBe("approve");
  });

  test("renders turn to Telegram outbound requests with thread + media fallback", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "t1",
      channel: "telegram",
      conversationId: "12345",
      threadId: "77",
      timestamp: 1_700_000_000_000,
      parts: [
        { type: "text", text: "hello" },
        { type: "image", uri: "https://example.com/a.png" },
        { type: "file", uri: "https://example.com/b.txt", name: "b.txt" },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn);
    expect(requests).toEqual([
      {
        method: "sendMessage",
        params: {
          chat_id: "12345",
          text: "hello",
          message_thread_id: 77,
        },
      },
      {
        method: "sendPhoto",
        params: {
          chat_id: "12345",
          photo: "https://example.com/a.png",
          message_thread_id: 77,
        },
      },
      {
        method: "sendDocument",
        params: {
          chat_id: "12345",
          document: "https://example.com/b.txt",
          message_thread_id: 77,
        },
      },
    ]);
  });

  test("splits inline approval text by max length and keeps buttons on first chunk only", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: "channel:session",
      turnId: "approval-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "Please approve this operation.\n".repeat(4).trim() }],
      approval: {
        requestId: "req-1234567890",
        title: "Approve command?",
        actions: [{ id: "approve", label: "Approve" }],
      },
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
      maxTextLength: 40,
    });
    const messages = requests.filter((entry) => entry.method === "sendMessage");
    expect(messages.length).toBeGreaterThan(1);
    expect(typeof messages[0]?.params.reply_markup).toBe("object");
    expect(messages.slice(1).every((entry) => entry.params.reply_markup === undefined)).toBe(true);
    expect(
      messages.every(
        (entry) => typeof entry.params.text === "string" && entry.params.text.length <= 40,
      ),
    ).toBe(true);
  });

  test("appends textual approval instructions when inline callbacks are unavailable", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "approval",
      sessionId: "channel:session",
      turnId: "approval-2",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [{ type: "text", text: "Please approve this operation." }],
      approval: {
        requestId: "req-1234567890",
        title: "Approve command?",
        actions: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
    });
    const messages = requests.filter((entry) => entry.method === "sendMessage");
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.some(
        (entry) =>
          typeof entry.params.text === "string" && entry.params.text.includes("Reply with one of:"),
      ),
    ).toBe(true);
  });

  test("builds deterministic dedupe keys", () => {
    const messageUpdate: TelegramUpdate = {
      update_id: 99,
      message: {
        message_id: 7,
        date: 1_700_000_001,
        chat: { id: 12345, type: "private" },
      },
    };
    const editUpdate: TelegramUpdate = {
      update_id: 100,
      edited_message: {
        message_id: 7,
        date: 1_700_000_002,
        chat: { id: 12345, type: "private" },
      },
    };
    const callbackUpdate: TelegramUpdate = {
      update_id: 101,
      callback_query: {
        id: "cb-7",
        from: { id: 1 },
      },
    };

    expect(buildTelegramInboundDedupeKey(messageUpdate)).toBe("telegram:12345:7");
    expect(buildTelegramInboundDedupeKey(editUpdate)).toBe("telegram:12345:edit:7:100");
    expect(buildTelegramInboundDedupeKey(callbackUpdate)).toBe("telegram:callback:cb-7");
  });
});
