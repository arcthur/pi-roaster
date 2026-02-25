import { describe, expect, test } from "bun:test";
import { createRuntimeChannelTurnBridge } from "@brewva/brewva-extensions";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  DEFAULT_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type TurnEnvelope,
} from "@brewva/brewva-runtime/channels";
import { assertRejectsWithMessage } from "../helpers.js";

type RuntimeLike = {
  events: {
    record: (input: Record<string, unknown>) => void;
  };
};

const BASE_TURN: TurnEnvelope = {
  schema: "brewva.turn.v1",
  kind: "assistant",
  sessionId: "channel:session",
  turnId: "turn-1",
  channel: "telegram",
  conversationId: "123",
  timestamp: 1_700_000_000_000,
  parts: [{ type: "text", text: "hello" }],
};

function createAdapter(options?: { sendError?: Error }): {
  adapter: ChannelAdapter;
  emitInbound: (turn: TurnEnvelope) => Promise<void>;
} {
  let onTurn: ((turn: TurnEnvelope) => Promise<void>) | null = null;
  const adapter: ChannelAdapter = {
    id: "telegram",
    capabilities: () => DEFAULT_CHANNEL_CAPABILITIES,
    start: async (params) => {
      onTurn = params.onTurn;
    },
    stop: async () => undefined,
    sendTurn: async () => {
      if (options?.sendError) {
        throw options.sendError;
      }
      return { providerMessageId: "tg:100" };
    },
  };

  return {
    adapter,
    emitInbound: async (turn) => {
      if (!onTurn) {
        throw new Error("adapter not started");
      }
      await onTurn(turn);
    },
  };
}

describe("channel turn bridge extension helper", () => {
  test("given inbound and outbound turns, when bridge runs, then ingested and emitted events are recorded", async () => {
    const events: Record<string, unknown>[] = [];
    const runtime: RuntimeLike = {
      events: {
        record: (input) => {
          events.push(input);
        },
      },
    };
    const inboundTurns: TurnEnvelope[] = [];
    const { adapter, emitInbound } = createAdapter();
    const bridge = createRuntimeChannelTurnBridge({
      runtime: runtime as unknown as BrewvaRuntime,
      adapter,
      onInboundTurn: async (turn) => {
        inboundTurns.push(turn);
      },
    });

    await bridge.start();
    await emitInbound({
      ...BASE_TURN,
      kind: "user",
      turnId: "turn-inbound",
      messageId: "10",
    });
    await bridge.sendTurn(BASE_TURN);
    await bridge.stop();

    expect(inboundTurns).toHaveLength(1);
    const eventTypes = events.map((entry) => entry.type);
    expect(eventTypes).toContain("channel_turn_ingested");
    expect(eventTypes).toContain("channel_turn_emitted");
  });

  test("given adapter send failure, when bridge sends turn, then bridge error event is recorded", async () => {
    const events: Record<string, unknown>[] = [];
    const runtime: RuntimeLike = {
      events: {
        record: (input) => {
          events.push(input);
        },
      },
    };
    const { adapter } = createAdapter({ sendError: new Error("send failed") });
    const bridge = createRuntimeChannelTurnBridge({
      runtime: runtime as unknown as BrewvaRuntime,
      adapter,
      onInboundTurn: async () => undefined,
    });

    await bridge.start();
    await assertRejectsWithMessage(() => bridge.sendTurn(BASE_TURN), "send failed");
    await bridge.stop();

    expect(events.some((entry) => entry.type === "channel_turn_bridge_error")).toBe(true);
  });

  test("given ingested session resolver, when inbound turn is handled, then recorded session id is normalized", async () => {
    const events: Record<string, unknown>[] = [];
    const runtime: RuntimeLike = {
      events: {
        record: (input) => {
          events.push(input);
        },
      },
    };
    const inboundTurns: TurnEnvelope[] = [];
    const { adapter, emitInbound } = createAdapter();
    const bridge = createRuntimeChannelTurnBridge({
      runtime: runtime as unknown as BrewvaRuntime,
      adapter,
      resolveIngestedSessionId: (turn) =>
        turn.sessionId === "channel:session" ? "agent-session-1" : undefined,
      onInboundTurn: async (turn) => {
        inboundTurns.push(turn);
      },
    });

    await bridge.start();
    await emitInbound({
      ...BASE_TURN,
      kind: "user",
      turnId: "turn-ingest-resolved",
    });
    await bridge.stop();

    expect(inboundTurns).toHaveLength(1);
    const ingested = events.find((entry) => entry.type === "channel_turn_ingested");
    expect(ingested?.sessionId).toBe("agent-session-1");
    expect((ingested?.payload as Record<string, unknown>)?.turnSessionId).toBe("channel:session");
  });
});
