import { describe, expect, test } from "bun:test";
import {
  decodeTelegramApprovalCallback,
  buildTelegramInboundDedupeKey,
  projectTelegramUpdateToTurn,
  renderTurnToTelegramRequests,
  type TelegramUpdate,
} from "@brewva/brewva-channels-telegram";
import { buildChannelSessionId, type TurnEnvelope } from "@brewva/brewva-runtime/channels";

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

  test("renders telegram-ui blocks from assistant text as inline callbacks", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `Please choose deployment action.
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy-confirm",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [
        [
          { "action_id": "confirm", "label": "Confirm", "style": "primary" },
          { "action_id": "cancel", "label": "Cancel", "style": "danger" }
        ]
      ]
    }
  ],
  "fallback_text": "Reply with: confirm or cancel"
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    const first = requests[0];
    const firstText = typeof first?.params.text === "string" ? first.params.text : "";
    expect(first?.method).toBe("sendMessage");
    expect(typeof first?.params.reply_markup).toBe("object");
    expect(firstText).toContain("Please choose deployment action.");
    expect(firstText).not.toContain("telegram-ui");
    const inlineKeyboard = (
      first?.params.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      }
    )?.inline_keyboard;
    expect(inlineKeyboard).toHaveLength(1);
    expect(inlineKeyboard?.[0]).toHaveLength(2);

    const callbackData = (inlineKeyboard?.[0]?.[0]?.callback_data ?? "").toString();
    const decoded = decodeTelegramApprovalCallback(callbackData, "callback-secret", {
      context: "12345",
    });
    expect(decoded?.actionId).toBe("confirm");
    expect(typeof decoded?.requestId).toBe("string");
    expect((decoded?.requestId ?? "").length).toBeGreaterThan(0);

    const cancelCallbackData = (inlineKeyboard?.[0]?.[1]?.callback_data ?? "").toString();
    const cancelDecoded = decodeTelegramApprovalCallback(cancelCallbackData, "callback-secret", {
      context: "12345",
    });
    expect(cancelDecoded?.actionId).toBe("cancel");
    expect(cancelDecoded?.requestId).toBe(decoded?.requestId);
  });

  test("persists and restores telegram-ui state via projection hooks", () => {
    const secret = "callback-secret";
    let persisted:
      | {
          conversationId: string;
          requestId: string;
          snapshot: {
            screenId?: string;
            stateKey?: string;
            state?: unknown;
          };
        }
      | undefined;
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-state-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy-confirm",
  "state_key": "deploy-confirm-st",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ],
  "state": { "flow": "deploy", "step": "confirm" }
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: secret,
      persistApprovalState: (params) => {
        persisted = params;
      },
    });
    expect(persisted).toBeDefined();
    expect(persisted?.conversationId).toBe("12345");
    expect(persisted?.snapshot.screenId).toBe("deploy-confirm");
    expect(persisted?.snapshot.stateKey).toBe("deploy-confirm-st");
    expect(persisted?.snapshot.state).toEqual({
      flow: "deploy",
      step: "confirm",
    });

    const callbackData = (
      (
        requests[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    expect(callbackData.length).toBeGreaterThan(0);

    const callbackUpdate: TelegramUpdate = {
      update_id: 101,
      callback_query: {
        id: "cbq-state-1",
        from: { id: 99, is_bot: false, first_name: "Ada", username: "ada" },
        message: {
          message_id: 200,
          date: 1_700_000_003,
          chat: { id: 12345, type: "private" },
        },
        data: callbackData,
      },
    };
    const callbackTurn = projectTelegramUpdateToTurn(callbackUpdate, {
      callbackSecret: secret,
      resolveApprovalState: (params) => {
        if (
          !persisted ||
          params.conversationId !== persisted.conversationId ||
          params.requestId !== persisted.requestId
        ) {
          return undefined;
        }
        return persisted.snapshot;
      },
    });

    expect(callbackTurn?.kind).toBe("approval");
    expect(callbackTurn?.approval?.detail).toContain("screen: deploy-confirm");
    expect(callbackTurn?.approval?.detail).toContain("state_key: deploy-confirm-st");
    expect(callbackTurn?.meta?.approvalScreenId).toBe("deploy-confirm");
    expect(callbackTurn?.meta?.approvalStateKey).toBe("deploy-confirm-st");
    expect(callbackTurn?.meta?.approvalState).toEqual({
      flow: "deploy",
      step: "confirm",
    });
  });

  test("renders multiple telegram-ui blocks from one assistant message", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-multi-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `intro
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "first-screen",
  "text": "First action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "first", "label": "First" }]]
    }
  ]
}
\`\`\`
next
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "second-screen",
  "text": "Second action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "second", "label": "Second" }]]
    }
  ]
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    const callbackMessages = requests.filter(
      (entry) => entry.method === "sendMessage" && entry.params.reply_markup !== undefined,
    );
    expect(callbackMessages).toHaveLength(2);
    expect(callbackMessages[0]?.params.text).toEqual(expect.stringContaining("intro"));
    expect(callbackMessages[0]?.params.text).toEqual(expect.not.stringContaining("telegram-ui"));
    expect(callbackMessages[1]?.params.text).toBe("Second action");

    const firstCallbackData = (
      (
        callbackMessages[0]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    const secondCallbackData = (
      (
        callbackMessages[1]?.params.reply_markup as {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        }
      )?.inline_keyboard?.[0]?.[0]?.callback_data ?? ""
    ).toString();
    const firstDecoded = decodeTelegramApprovalCallback(firstCallbackData, "callback-secret", {
      context: "12345",
    });
    const secondDecoded = decodeTelegramApprovalCallback(secondCallbackData, "callback-secret", {
      context: "12345",
    });
    expect(firstDecoded?.actionId).toBe("first");
    expect(secondDecoded?.actionId).toBe("second");
  });

  test("does not parse telegram-ui block from tool turns", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "tool",
      sessionId: "channel:session",
      turnId: "tool-ui-1",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `tool output
\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "should-not-render",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [[{ "action_id": "confirm", "label": "Confirm" }]]
    }
  ]
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
      callbackSecret: "callback-secret",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params.reply_markup).toBeUndefined();
    expect(requests[0]?.params.text).toEqual(expect.stringContaining("telegram-ui"));
  });

  test("falls back to textual telegram-ui instructions when callback secret is missing", () => {
    const turn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "assistant-ui-2",
      channel: "telegram",
      conversationId: "12345",
      timestamp: 1_700_000_000_000,
      parts: [
        {
          type: "text",
          text: `\`\`\`telegram-ui
{
  "version": "telegram-ui/v1",
  "screen_id": "deploy-confirm",
  "text": "Choose deploy action",
  "components": [
    {
      "type": "buttons",
      "rows": [
        [
          { "action_id": "confirm", "label": "Confirm" },
          { "action_id": "cancel", "label": "Cancel" }
        ]
      ]
    }
  ],
  "fallback_text": "Reply with: confirm or cancel"
}
\`\`\``,
        },
      ],
    };

    const requests = renderTurnToTelegramRequests(turn, {
      inlineApproval: true,
    });
    const messages = requests.filter((entry) => entry.method === "sendMessage");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((entry) => entry.params.reply_markup !== undefined)).toBe(false);
    expect(
      messages.some(
        (entry) =>
          typeof entry.params.text === "string" &&
          entry.params.text.includes("Reply with: confirm or cancel"),
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
