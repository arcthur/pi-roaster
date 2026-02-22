import type {
  AdapterSendResult,
  AdapterStartContext,
  ChannelAdapter,
} from "@brewva/brewva-runtime";
import { resolveChannelCapabilities, type ChannelCapabilities } from "@brewva/brewva-runtime";
import {
  buildTelegramInboundDedupeKey,
  projectTelegramUpdateToTurn,
  renderTurnToTelegramRequests,
  type TelegramInboundProjectionOptions,
  type TelegramOutboundRenderOptions,
} from "./projector.js";
import type { TelegramOutboundRequest, TelegramUpdate } from "./types.js";

const TELEGRAM_DEDUPE_MAX_ENTRIES_DEFAULT = 2048;
const TELEGRAM_DEDUPE_MAX_ENTRIES_MIN = 32;
const TELEGRAM_DEDUPE_MAX_ENTRIES_MAX = 50_000;

export const TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  inlineActions: true,
  codeBlocks: true,
  multiModal: true,
  threadedReplies: true,
};

export interface TelegramChannelTransportSendResult {
  providerMessageId?: string | number;
}

export interface TelegramChannelTransport {
  start(params: { onUpdate: (update: TelegramUpdate) => Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  send(
    request: TelegramOutboundRequest,
  ): Promise<TelegramChannelTransportSendResult | void> | TelegramChannelTransportSendResult | void;
}

export type TelegramChannelCapabilitiesResolver =
  | Partial<ChannelCapabilities>
  | ((params: { conversationId: string }) => Partial<ChannelCapabilities>);

export interface TelegramInboundDedupeOptions {
  enabled?: boolean;
  maxEntries?: number;
}

export interface TelegramCallbackAckOptions {
  enabled?: boolean;
  text?: string;
  showAlert?: boolean;
  cacheTimeSeconds?: number;
}

export interface TelegramChannelAdapterOptions {
  transport: TelegramChannelTransport;
  capabilities?: TelegramChannelCapabilitiesResolver;
  inbound?: TelegramInboundProjectionOptions;
  outbound?: TelegramOutboundRenderOptions;
  dedupe?: TelegramInboundDedupeOptions;
  callbackAck?: TelegramCallbackAckOptions;
}

type DedupeStatus = "inflight" | "done";

function normalizeProviderMessageId(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveDedupeMaxEntries(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return TELEGRAM_DEDUPE_MAX_ENTRIES_DEFAULT;
  }
  const floored = Math.floor(input);
  return Math.max(
    TELEGRAM_DEDUPE_MAX_ENTRIES_MIN,
    Math.min(TELEGRAM_DEDUPE_MAX_ENTRIES_MAX, floored),
  );
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalNonNegativeInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";

  private startContext: AdapterStartContext | null = null;
  private readonly inboundDedupeState = new Map<string, DedupeStatus>();
  private readonly dedupeEnabled: boolean;
  private readonly dedupeMaxEntries: number;
  private readonly callbackAckEnabled: boolean;
  private readonly callbackAckText: string | undefined;
  private readonly callbackAckShowAlert: boolean | undefined;
  private readonly callbackAckCacheTimeSeconds: number | undefined;

  constructor(private readonly options: TelegramChannelAdapterOptions) {
    this.dedupeEnabled = options.dedupe?.enabled ?? true;
    this.dedupeMaxEntries = resolveDedupeMaxEntries(options.dedupe?.maxEntries);
    this.callbackAckEnabled = options.callbackAck?.enabled ?? true;
    this.callbackAckText = normalizeOptionalText(options.callbackAck?.text);
    this.callbackAckShowAlert =
      typeof options.callbackAck?.showAlert === "boolean"
        ? options.callbackAck.showAlert
        : undefined;
    this.callbackAckCacheTimeSeconds = normalizeOptionalNonNegativeInt(
      options.callbackAck?.cacheTimeSeconds,
    );
  }

  capabilities(params: { conversationId: string }): ChannelCapabilities {
    const resolved =
      typeof this.options.capabilities === "function"
        ? this.options.capabilities(params)
        : this.options.capabilities;
    return resolveChannelCapabilities({
      ...TELEGRAM_CHANNEL_DEFAULT_CAPABILITIES,
      ...resolved,
    });
  }

  async start(params: AdapterStartContext): Promise<void> {
    if (this.startContext) return;
    this.startContext = params;
    try {
      await this.options.transport.start({
        onUpdate: async (update) => {
          await this.handleUpdate(update);
        },
      });
    } catch (error) {
      this.startContext = null;
      this.inboundDedupeState.clear();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.startContext) return;
    await this.options.transport.stop();
    this.startContext = null;
    this.inboundDedupeState.clear();
  }

  async sendTurn(
    turn: Parameters<typeof renderTurnToTelegramRequests>[0],
  ): Promise<AdapterSendResult> {
    const requests = renderTurnToTelegramRequests(turn, this.options.outbound);
    if (requests.length === 0) {
      return {};
    }

    let providerMessageId: string | undefined;
    const providerMessageIds: string[] = [];
    for (const request of requests) {
      const result = await this.options.transport.send(request);
      const nextProviderMessageId = normalizeProviderMessageId(result?.providerMessageId);
      if (nextProviderMessageId) {
        providerMessageId = nextProviderMessageId;
        providerMessageIds.push(nextProviderMessageId);
      }
    }

    return {
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(providerMessageIds.length > 0 ? { providerMessageIds } : {}),
    };
  }

  private beginInboundProcessing(key: string | null): boolean {
    if (!this.dedupeEnabled || !key) {
      return true;
    }
    if (this.inboundDedupeState.has(key)) {
      return false;
    }
    this.inboundDedupeState.set(key, "inflight");
    return true;
  }

  private finishInboundProcessing(key: string | null, ok: boolean): void {
    if (!this.dedupeEnabled || !key) {
      return;
    }

    if (!ok) {
      this.inboundDedupeState.delete(key);
      return;
    }

    this.inboundDedupeState.set(key, "done");
    while (this.inboundDedupeState.size > this.dedupeMaxEntries) {
      const oldest = this.inboundDedupeState.keys().next().value;
      if (!oldest) break;
      this.inboundDedupeState.delete(oldest);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const context = this.startContext;
    if (!context) {
      return;
    }

    const dedupeKey = this.dedupeEnabled ? buildTelegramInboundDedupeKey(update) : null;
    if (!this.beginInboundProcessing(dedupeKey)) {
      return;
    }

    try {
      const projected = projectTelegramUpdateToTurn(update, this.options.inbound);
      if (!projected) {
        this.finishInboundProcessing(dedupeKey, true);
        return;
      }
      await this.ackCallbackQuery(update);
      await context.onTurn(projected);
      this.finishInboundProcessing(dedupeKey, true);
    } catch (error) {
      this.finishInboundProcessing(dedupeKey, false);
      throw error;
    }
  }

  private async ackCallbackQuery(update: TelegramUpdate): Promise<void> {
    if (!this.callbackAckEnabled) {
      return;
    }
    const callbackQueryId = update.callback_query?.id?.trim();
    if (!callbackQueryId) {
      return;
    }

    const params: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (this.callbackAckText) {
      params.text = this.callbackAckText;
    }
    if (this.callbackAckShowAlert !== undefined) {
      params.show_alert = this.callbackAckShowAlert;
    }
    if (this.callbackAckCacheTimeSeconds !== undefined) {
      params.cache_time = this.callbackAckCacheTimeSeconds;
    }

    try {
      await this.options.transport.send({
        method: "answerCallbackQuery",
        params,
      });
    } catch {
      // Telegram callback confirmation is best-effort and should not break turn ingestion.
    }
  }
}
