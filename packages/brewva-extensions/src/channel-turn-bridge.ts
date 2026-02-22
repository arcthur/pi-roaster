import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ChannelAdapter, ChannelTurnBridge, TurnEnvelope } from "@brewva/brewva-runtime";
import { ChannelTurnBridge as RuntimeChannelTurnBridge } from "@brewva/brewva-runtime";

export interface CreateRuntimeChannelTurnBridgeOptions {
  runtime: BrewvaRuntime;
  adapter: ChannelAdapter;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  resolveIngestedSessionId?: (
    turn: TurnEnvelope,
  ) => Promise<string | undefined> | string | undefined;
}

function summarizeTurn(turn: TurnEnvelope): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    kind: turn.kind,
    channel: turn.channel,
    conversationId: turn.conversationId,
    messageId: turn.messageId ?? null,
    threadId: turn.threadId ?? null,
    partTypes: turn.parts.map((part) => part.type),
    partCount: turn.parts.length,
    timestamp: turn.timestamp,
  };
}

export function createRuntimeChannelTurnBridge(
  options: CreateRuntimeChannelTurnBridgeOptions,
): ChannelTurnBridge {
  return new RuntimeChannelTurnBridge(options.adapter, {
    onInboundTurn: options.onInboundTurn,
    onAdapterError: async (error) => {
      options.runtime.recordEvent({
        sessionId: "channel:system",
        type: "channel_turn_bridge_error",
        payload: {
          adapterId: options.adapter.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      await options.onAdapterError?.(error);
    },
    onTurnIngested: async (turn) => {
      const resolvedSessionId = await options.resolveIngestedSessionId?.(turn);
      const eventSessionId = resolvedSessionId?.trim() || turn.sessionId;
      options.runtime.recordEvent({
        sessionId: eventSessionId,
        type: "channel_turn_ingested",
        payload: {
          adapterId: options.adapter.id,
          turnSessionId: turn.sessionId,
          ...summarizeTurn(turn),
        },
      });
    },
    onTurnEmitted: async (input) => {
      options.runtime.recordEvent({
        sessionId: input.deliveredTurn.sessionId,
        type: "channel_turn_emitted",
        payload: {
          adapterId: options.adapter.id,
          ...summarizeTurn(input.deliveredTurn),
          requestedTurnId: input.requestedTurn.turnId,
          providerMessageId: input.result.providerMessageId ?? null,
        },
      });
    },
  });
}
