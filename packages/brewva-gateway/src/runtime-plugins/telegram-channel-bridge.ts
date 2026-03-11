import {
  TelegramChannelAdapter,
  TelegramHttpTransport,
  type TelegramChannelTransport,
  type TelegramChannelAdapterOptions,
  type TelegramHttpTransportOptions,
} from "@brewva/brewva-channels-telegram";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ChannelTurnBridge, TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createRuntimeChannelTurnBridge } from "./channel-turn-bridge.js";

export interface CreateRuntimeTelegramChannelBridgeOptions {
  runtime: BrewvaRuntime;
  token?: string;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  resolveIngestedSessionId?: (
    turn: TurnEnvelope,
  ) => Promise<string | undefined> | string | undefined;
  adapter?: Omit<TelegramChannelAdapterOptions, "transport">;
  transport?: Omit<TelegramHttpTransportOptions, "token">;
  transportInstance?: TelegramChannelTransport;
}

export interface RuntimeTelegramChannelBridge {
  bridge: ChannelTurnBridge;
  adapter: TelegramChannelAdapter;
  transport: TelegramChannelTransport;
}

export function createRuntimeTelegramChannelBridge(
  options: CreateRuntimeTelegramChannelBridgeOptions,
): RuntimeTelegramChannelBridge {
  const transport =
    options.transportInstance ??
    (() => {
      const token = options.token?.trim() ?? "";
      if (!token) {
        throw new Error("telegram token is required when transportInstance is not provided");
      }
      return new TelegramHttpTransport({
        token,
        ...options.transport,
      });
    })();
  const adapter = new TelegramChannelAdapter({
    ...options.adapter,
    transport,
  });
  const bridge = createRuntimeChannelTurnBridge({
    runtime: options.runtime,
    adapter,
    onInboundTurn: options.onInboundTurn,
    onAdapterError: options.onAdapterError,
    resolveIngestedSessionId: options.resolveIngestedSessionId,
  });
  return { bridge, adapter, transport };
}
