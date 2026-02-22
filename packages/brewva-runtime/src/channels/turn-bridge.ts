import type { AdapterSendResult, ChannelAdapter } from "./adapter.js";
import { prepareTurnForDelivery } from "./output-policy.js";
import type { TurnEnvelope } from "./turn.js";

export interface TurnBridgeHandlers {
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  onTurnIngested?: (turn: TurnEnvelope) => Promise<void> | void;
  onTurnEmitted?: (input: {
    requestedTurn: TurnEnvelope;
    deliveredTurn: TurnEnvelope;
    result: AdapterSendResult;
  }) => Promise<void> | void;
  onStreamChunk?: (turn: TurnEnvelope, chunk: string) => void;
}

export class ChannelTurnBridge {
  private running = false;

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly handlers: TurnBridgeHandlers,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    await this.adapter.start({
      onTurn: async (turn) => {
        await this.handlers.onTurnIngested?.(turn);
        await this.handlers.onInboundTurn(turn);
      },
    });
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.adapter.stop();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendTurn(turn: TurnEnvelope): Promise<AdapterSendResult> {
    try {
      const capabilities = this.adapter.capabilities({
        conversationId: turn.conversationId,
      });
      const prepared = prepareTurnForDelivery(turn, capabilities);
      let result: AdapterSendResult;
      if (capabilities.streaming && this.adapter.sendTurnStream) {
        result = await this.adapter.sendTurnStream(prepared, {
          write: (chunk) => {
            this.handlers.onStreamChunk?.(prepared, chunk);
          },
        });
      } else {
        result = await this.adapter.sendTurn(prepared);
      }
      await this.handlers.onTurnEmitted?.({
        requestedTurn: turn,
        deliveredTurn: prepared,
        result,
      });
      return result;
    } catch (error) {
      await this.handlers.onAdapterError?.(error);
      throw error;
    }
  }
}
