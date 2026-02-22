import type { TelegramChannelTransport, TelegramChannelTransportSendResult } from "./adapter.js";
import type { TelegramOutboundRequest, TelegramUpdate } from "./types.js";

const TELEGRAM_API_BASE_URL_DEFAULT = "https://api.telegram.org";
const TELEGRAM_POLL_TIMEOUT_SECONDS_DEFAULT = 20;
const TELEGRAM_POLL_LIMIT_DEFAULT = 100;
const TELEGRAM_POLL_RETRY_DELAY_MS_DEFAULT = 1_000;
const TELEGRAM_POLL_LIMIT_MIN = 1;
const TELEGRAM_POLL_LIMIT_MAX = 100;
const TELEGRAM_POLL_TIMEOUT_MIN = 0;
const TELEGRAM_POLL_TIMEOUT_MAX = 600;

interface TelegramApiOkResponse<T> {
  ok: true;
  result: T;
}

interface TelegramApiErrorResponse {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: Record<string, unknown>;
}

type TelegramApiResponse<T> = TelegramApiOkResponse<T> | TelegramApiErrorResponse;

export type TelegramFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type SleepLike = (delayMs: number) => Promise<void>;

export interface TelegramLongPollingOptions {
  timeoutSeconds?: number;
  limit?: number;
  allowedUpdates?: string[];
  retryDelayMs?: number;
}

export interface TelegramHttpTransportOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: TelegramFetchLike;
  sleepImpl?: SleepLike;
  poll?: TelegramLongPollingOptions;
  initialOffset?: number;
  onError?: (error: unknown) => Promise<void> | void;
}

interface TelegramSendResultPayload {
  message_id?: string | number;
}

function normalizeToken(token: string): string {
  const normalized = token.trim();
  if (!normalized) {
    throw new Error("telegram token is required");
  }
  return normalized;
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const normalized = (value ?? TELEGRAM_API_BASE_URL_DEFAULT).trim();
  if (!normalized) {
    throw new Error("telegram apiBaseUrl is required");
  }
  return normalized.replace(/\/+$/g, "");
}

function normalizePollTimeoutSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_POLL_TIMEOUT_SECONDS_DEFAULT;
  }
  return Math.max(
    TELEGRAM_POLL_TIMEOUT_MIN,
    Math.min(TELEGRAM_POLL_TIMEOUT_MAX, Math.floor(value)),
  );
}

function normalizePollLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_POLL_LIMIT_DEFAULT;
  }
  return Math.max(TELEGRAM_POLL_LIMIT_MIN, Math.min(TELEGRAM_POLL_LIMIT_MAX, Math.floor(value)));
}

function normalizeRetryDelayMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_POLL_RETRY_DELAY_MS_DEFAULT;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeInitialOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function buildApiError(method: string, message: string): Error {
  return new Error(`telegram api ${method} failed: ${message}`);
}

function buildHttpError(method: string, status: number, text: string): Error {
  const summary = text.trim();
  return new Error(
    `telegram http ${method} failed: status=${status}${summary ? ` body=${summary}` : ""}`,
  );
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export class TelegramHttpTransport implements TelegramChannelTransport {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: TelegramFetchLike;
  private readonly sleepImpl: SleepLike;
  private readonly pollTimeoutSeconds: number;
  private readonly pollLimit: number;
  private readonly pollAllowedUpdates: string[] | undefined;
  private readonly retryDelayMs: number;
  private readonly onError: ((error: unknown) => Promise<void> | void) | undefined;

  private running = false;
  private onUpdate: ((update: TelegramUpdate) => Promise<void>) | null = null;
  private pollLoopTask: Promise<void> | null = null;
  private activePollAbortController: AbortController | null = null;
  private nextOffset: number;

  constructor(options: TelegramHttpTransportOptions) {
    this.token = normalizeToken(options.token);
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.pollTimeoutSeconds = normalizePollTimeoutSeconds(options.poll?.timeoutSeconds);
    this.pollLimit = normalizePollLimit(options.poll?.limit);
    this.pollAllowedUpdates =
      options.poll?.allowedUpdates?.map((value) => value.trim()).filter(Boolean) ?? undefined;
    this.retryDelayMs = normalizeRetryDelayMs(options.poll?.retryDelayMs);
    this.onError = options.onError;
    this.nextOffset = normalizeInitialOffset(options.initialOffset);
  }

  async start(params: { onUpdate: (update: TelegramUpdate) => Promise<void> }): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.onUpdate = params.onUpdate;
    this.pollLoopTask = this.runPollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.activePollAbortController?.abort();
    if (this.pollLoopTask) {
      await this.pollLoopTask;
    }
    this.pollLoopTask = null;
    this.onUpdate = null;
    this.activePollAbortController = null;
  }

  async send(request: TelegramOutboundRequest): Promise<TelegramChannelTransportSendResult> {
    const payload = await this.callApi<TelegramSendResultPayload>(request.method, request.params);
    const messageId = payload && typeof payload === "object" ? payload.message_id : undefined;
    if (messageId === undefined || messageId === null) {
      return {};
    }
    return { providerMessageId: messageId };
  }

  private async runPollLoop(): Promise<void> {
    while (this.running) {
      const abortController = new AbortController();
      this.activePollAbortController = abortController;
      try {
        const updates = await this.fetchUpdates(abortController.signal);
        await this.processUpdates(updates);
      } catch (error) {
        if (isAbortError(error)) {
          if (!this.running) {
            break;
          }
          continue;
        }
        await this.reportError(error);
        if (this.running && this.retryDelayMs > 0) {
          await this.sleepImpl(this.retryDelayMs);
        }
      } finally {
        if (this.activePollAbortController === abortController) {
          this.activePollAbortController = null;
        }
      }
    }
  }

  private async fetchUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const request: Record<string, unknown> = {
      timeout: this.pollTimeoutSeconds,
      limit: this.pollLimit,
      ...(this.nextOffset > 0 ? { offset: this.nextOffset } : {}),
      ...(this.pollAllowedUpdates && this.pollAllowedUpdates.length > 0
        ? { allowed_updates: this.pollAllowedUpdates }
        : {}),
    };
    return this.callApi<TelegramUpdate[]>("getUpdates", request, signal);
  }

  private async processUpdates(updates: TelegramUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const handler = this.onUpdate;
    if (!handler) {
      return;
    }

    for (const update of updates) {
      const updateId = Number(update.update_id);
      await handler(update);
      if (Number.isInteger(updateId)) {
        this.nextOffset = Math.max(this.nextOffset, updateId + 1);
      }
    }
  }

  private async callApi<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(this.buildMethodUrl(method), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
      signal,
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      throw buildHttpError(method, response.status, body);
    }

    let parsed: TelegramApiResponse<T>;
    try {
      parsed = (await response.json()) as TelegramApiResponse<T>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw buildApiError(method, `invalid json response (${message})`);
    }

    if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
      throw buildApiError(method, "unexpected response shape");
    }

    if (!parsed.ok) {
      const errorCode =
        typeof parsed.error_code === "number" && Number.isFinite(parsed.error_code)
          ? parsed.error_code
          : null;
      const description =
        typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description.trim()
          : "unknown";
      throw buildApiError(
        method,
        `${errorCode !== null ? `code=${errorCode} ` : ""}${description}`.trim(),
      );
    }

    return parsed.result;
  }

  private buildMethodUrl(method: string): string {
    return `${this.apiBaseUrl}/bot${this.token}/${method}`;
  }

  private async reportError(error: unknown): Promise<void> {
    if (!this.onError) {
      return;
    }
    try {
      await this.onError(error);
    } catch {
      // Ignore telemetry callback failures to keep polling alive.
    }
  }
}
