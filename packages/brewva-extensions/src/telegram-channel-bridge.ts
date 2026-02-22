import {
  TelegramChannelAdapter,
  TelegramHttpTransport,
  type TelegramChannelAdapterOptions,
  type TelegramHttpTransportOptions,
} from "@brewva/brewva-channels-telegram";
import type { BrewvaRuntime, ChannelTurnBridge, TurnEnvelope } from "@brewva/brewva-runtime";
import { createRuntimeChannelTurnBridge } from "./channel-turn-bridge.js";

export interface CreateRuntimeTelegramChannelBridgeOptions {
  runtime: BrewvaRuntime;
  token: string;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  resolveIngestedSessionId?: (
    turn: TurnEnvelope,
  ) => Promise<string | undefined> | string | undefined;
  adapter?: Omit<TelegramChannelAdapterOptions, "transport">;
  transport?: Omit<TelegramHttpTransportOptions, "token">;
}

export interface RuntimeTelegramChannelBridge {
  bridge: ChannelTurnBridge;
  adapter: TelegramChannelAdapter;
  transport: TelegramHttpTransport;
}

export function createRuntimeTelegramChannelBridge(
  options: CreateRuntimeTelegramChannelBridgeOptions,
): RuntimeTelegramChannelBridge {
  const transport = new TelegramHttpTransport({
    token: options.token,
    ...options.transport,
  });
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
