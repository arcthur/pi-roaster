import { describe, expect, test } from "bun:test";
import type {
  AdapterStartContext,
  ChannelAdapter,
  TurnEnvelope,
} from "@brewva/brewva-runtime/channels";
import { ChannelTurnBridge } from "@brewva/brewva-runtime/channels";

const BASE_TURN: TurnEnvelope = {
  schema: "brewva.turn.v1",
  kind: "assistant",
  sessionId: "channel:session",
  turnId: "t-1",
  channel: "telegram",
  conversationId: "123",
  threadId: "thread-42",
  timestamp: 1_700_000_000_000,
  parts: [{ type: "text", text: "hello" }],
};

function createAdapter(): {
  adapter: ChannelAdapter;
  sentTurns: TurnEnvelope[];
  emitInbound: (turn: TurnEnvelope) => Promise<void>;
} {
  let startContext: AdapterStartContext | null = null;
  const sentTurns: TurnEnvelope[] = [];
  const adapter: ChannelAdapter = {
    id: "telegram",
    capabilities: () => ({
      streaming: false,
      inlineActions: false,
      codeBlocks: true,
      multiModal: true,
      threadedReplies: false,
    }),
    start: async (ctx) => {
      startContext = ctx;
    },
    stop: async () => undefined,
    sendTurn: async (turn) => {
      sentTurns.push(turn);
      return { providerMessageId: "out-1" };
    },
  };

  return {
    adapter,
    sentTurns,
    emitInbound: async (turn) => {
      if (!startContext) {
        throw new Error("adapter not started");
      }
      await startContext.onTurn(turn);
    },
  };
}

describe("channel turn bridge", () => {
  test("given adapter inbound callback, when bridge receives turn, then turn is forwarded and ingestion hook is invoked", async () => {
    const inbound: TurnEnvelope[] = [];
    const ingested: TurnEnvelope[] = [];
    const { adapter, emitInbound } = createAdapter();
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async (turn) => {
        inbound.push(turn);
      },
      onTurnIngested: async (turn) => {
        ingested.push(turn);
      },
    });

    await bridge.start();
    await emitInbound(BASE_TURN);
    expect(inbound).toEqual([BASE_TURN]);
    expect(ingested).toEqual([BASE_TURN]);
    await bridge.stop();
  });

  test("given channel lacks thread replies, when bridge sends outbound turn, then thread context is normalized before delivery", async () => {
    const { adapter, sentTurns } = createAdapter();
    const emitted: Array<{ requestedTurn: TurnEnvelope; deliveredTurn: TurnEnvelope }> = [];
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async () => undefined,
      onTurnEmitted: async (input) => {
        emitted.push({
          requestedTurn: input.requestedTurn,
          deliveredTurn: input.deliveredTurn,
        });
      },
    });

    await bridge.start();
    await bridge.sendTurn(BASE_TURN);
    await bridge.stop();

    expect(sentTurns).toHaveLength(1);
    const sent = sentTurns[0];
    if (!sent) {
      throw new Error("expected sent turn");
    }
    expect(sent.parts[0]).toEqual({
      type: "text",
      text: "[thread:thread-42]\nhello",
    });
    const deliveryPlan = sent.meta?.deliveryPlan as { threadMode?: string } | undefined;
    expect(deliveryPlan?.threadMode).toBe("prepend_context");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.requestedTurn.turnId).toBe(BASE_TURN.turnId);
    expect(emitted[0]?.deliveredTurn.turnId).toBe(BASE_TURN.turnId);
  });
});
