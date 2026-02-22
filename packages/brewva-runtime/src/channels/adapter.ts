import type { ChannelCapabilities } from "./capabilities.js";
import type { TurnEnvelope } from "./turn.js";

export interface AdapterSendResult {
  providerMessageId?: string;
  providerMessageIds?: string[];
}

export interface AdapterStartContext {
  onTurn: (turn: TurnEnvelope) => Promise<void>;
}

export interface TurnStreamEmitter {
  write(chunk: string): void;
}

export interface ChannelAdapter {
  readonly id: string;
  capabilities(params: { conversationId: string }): ChannelCapabilities;
  start(params: AdapterStartContext): Promise<void>;
  stop(): Promise<void>;
  sendTurn(turn: TurnEnvelope): Promise<AdapterSendResult>;
  sendTurnStream?(turn: TurnEnvelope, emitter: TurnStreamEmitter): Promise<AdapterSendResult>;
}
