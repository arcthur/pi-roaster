import { describe, expect, test } from "bun:test";
import {
  TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
  TelegramChannelAdapter,
  type TelegramChannelTransport,
} from "../../packages/brewva-channels-telegram/src/adapter.js";
import { encodeTelegramApprovalCallback } from "../../packages/brewva-channels-telegram/src/approval-callback.js";
import type {
  TelegramOutboundRequest,
  TelegramUpdate,
} from "../../packages/brewva-channels-telegram/src/types.js";
import type { TurnEnvelope } from "../../packages/brewva-runtime/src/channels/turn.js";
import { assertRejectsWithMessage } from "../helpers.js";

function createMessageUpdate(): TelegramUpdate {
  return {
    update_id: 9001,
    message: {
      message_id: 77,
      date: 1_700_000_000,
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      text: "hello adapter",
    },
  };
}

function createApprovalCallbackUpdate(secret: string): TelegramUpdate {
  return {
    update_id: 9002,
    callback_query: {
      id: "cbq-1",
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      message: {
        message_id: 77,
        date: 1_700_000_000,
        chat: { id: 12345, type: "private" },
      },
      data: encodeTelegramApprovalCallback(
        { requestId: "req-1234567890", actionId: "approve" },
        secret,
        { context: "12345" },
      ),
    },
  };
}

function createTransport() {
  let onUpdate: ((update: TelegramUpdate) => Promise<void>) | null = null;
  const sent: TelegramOutboundRequest[] = [];
  const sendResults: Array<{ providerMessageId?: string | number }> = [];
  let startCalls = 0;
  let stopCalls = 0;

  const transport: TelegramChannelTransport = {
    start: async (params) => {
      startCalls += 1;
      onUpdate = params.onUpdate;
    },
    stop: async () => {
      stopCalls += 1;
      onUpdate = null;
    },
    send: async (request) => {
      sent.push(request);
      return sendResults.shift() ?? {};
    },
  };

  return {
    transport,
    sent,
    sendResults,
    getStartCalls: () => startCalls,
    getStopCalls: () => stopCalls,
    async emitUpdate(update: TelegramUpdate): Promise<void> {
      if (!onUpdate) {
        throw new Error("transport not started");
      }
      await onUpdate(update);
    },
  };
}

describe("channel telegram adapter", () => {
  test("projects inbound update to turn and dedupes by default", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });
    const inbound: TurnEnvelope[] = [];

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });

    const update = createMessageUpdate();
    await transport.emitUpdate(update);
    await transport.emitUpdate(update);
    await adapter.stop();

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.kind).toBe("user");
    expect(inbound[0]?.conversationId).toBe("12345");
    expect(inbound[0]?.turnId).toBe("tg:message:12345:77");
  });

  test("retries same update when inbound callback fails once", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });
    let attempts = 0;

    await adapter.start({
      onTurn: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    const update = createMessageUpdate();
    await assertRejectsWithMessage(() => transport.emitUpdate(update), "temporary failure");
    await transport.emitUpdate(update);
    await adapter.stop();

    expect(attempts).toBe(2);
  });

  test("acknowledges callback query after approval turn is ingested", async () => {
    const transport = createTransport();
    const secret = "callback-secret";
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      inbound: { callbackSecret: secret },
    });
    const inbound: TurnEnvelope[] = [];

    await adapter.start({
      onTurn: async (turn) => {
        inbound.push(turn);
      },
    });

    await transport.emitUpdate(createApprovalCallbackUpdate(secret));
    await adapter.stop();

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.kind).toBe("approval");
    expect(transport.sent).toContainEqual({
      method: "answerCallbackQuery",
      params: { callback_query_id: "cbq-1" },
    });
  });

  test("can disable inbound dedupe", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      dedupe: { enabled: false },
    });
    let count = 0;

    await adapter.start({
      onTurn: async () => {
        count += 1;
      },
    });

    const update = createMessageUpdate();
    await transport.emitUpdate(update);
    await transport.emitUpdate(update);
    await adapter.stop();

    expect(count).toBe(2);
  });

  test("renders outbound requests and returns last provider message id", async () => {
    const transport = createTransport();
    transport.sendResults.push({ providerMessageId: 100 }, { providerMessageId: "101" });
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });
    const outboundTurn: TurnEnvelope = {
      schema: "brewva.turn.v1",
      kind: "assistant",
      sessionId: "channel:session",
      turnId: "outbound-1",
      channel: "telegram",
      conversationId: "12345",
      threadId: "11",
      timestamp: 1_700_000_000_000,
      parts: [
        { type: "text", text: "hello outbound" },
        { type: "image", uri: "https://example.com/a.jpg" },
      ],
    };

    const result = await adapter.sendTurn(outboundTurn);

    expect(transport.sent).toEqual([
      {
        method: "sendMessage",
        params: {
          chat_id: "12345",
          text: "hello outbound",
          message_thread_id: 11,
        },
      },
      {
        method: "sendPhoto",
        params: {
          chat_id: "12345",
          photo: "https://example.com/a.jpg",
          message_thread_id: 11,
        },
      },
    ]);
    expect(result).toEqual({ providerMessageId: "101", providerMessageIds: ["100", "101"] });
  });

  test("supports dynamic capability resolver", () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
      capabilities: ({ conversationId }) =>
        conversationId === "stream-room" ? { streaming: true } : { inlineActions: false },
    });

    expect(adapter.capabilities({ conversationId: "stream-room" })).toEqual({
      ...TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
      streaming: true,
    });
    expect(adapter.capabilities({ conversationId: "other-room" })).toEqual({
      ...TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
      inlineActions: false,
    });
  });

  test("start and stop are idempotent", async () => {
    const transport = createTransport();
    const adapter = new TelegramChannelAdapter({
      transport: transport.transport,
    });

    await adapter.start({ onTurn: async () => undefined });
    await adapter.start({ onTurn: async () => undefined });
    await adapter.stop();
    await adapter.stop();

    expect(transport.getStartCalls()).toBe(1);
    expect(transport.getStopCalls()).toBe(1);
  });
});
