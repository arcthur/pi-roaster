import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { normalizeGatewayHost, assertLoopbackHost } from "./network.js";
import type { GatewayErrorShape, GatewayMethod, GatewayParamsByMethod } from "./protocol/index.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { validateGatewayFrame } from "./protocol/validate.js";
import { safeParseJson } from "./utils/json.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: () => boolean;
}

interface PendingResponse {
  resolve: (frame: GatewayResponseFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GatewayResponseFrame {
  type: "res";
  id: string;
  traceId?: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayErrorShape;
}

interface GatewayEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

export type GatewayClientEvent = GatewayEventFrame;
export type GatewayClientEventListener = (event: GatewayClientEvent) => void;

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    rejectValue = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
    settled: () => settled,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => {
        rejectPromise(new Error(message));
      },
      Math.max(100, timeoutMs),
    );
    timer.unref?.();

    promise
      .then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
  });
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    const serialized = JSON.stringify(error);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // fall through
  }
  return "non-serializable error";
}

function toErrorFromGatewayShape(shape: GatewayErrorShape | undefined): Error {
  if (!shape) {
    return new Error("gateway request failed");
  }
  return new Error(`[${shape.code}] ${shape.message}`);
}

export interface GatewayClientConnectOptions {
  host: string;
  port: number;
  token: string;
  clientId?: string;
  clientVersion?: string;
  clientMode?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class GatewayClient {
  private readonly ws: WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly eventListeners = new Set<GatewayClientEventListener>();
  private readonly openDeferred = createDeferred<void>();
  private readonly closeDeferred = createDeferred<void>();
  private readonly challengeDeferred = createDeferred<string>();
  private ready = false;
  private closed = false;

  private constructor(
    ws: WebSocket,
    private readonly options: {
      requestTimeoutMs: number;
      connectTimeoutMs: number;
      token: string;
      clientId: string;
      clientVersion: string;
      clientMode?: string;
    },
  ) {
    this.ws = ws;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.attachSocketListeners();
  }

  static async connect(options: GatewayClientConnectOptions): Promise<GatewayClient> {
    const host = normalizeGatewayHost(options.host);
    assertLoopbackHost(host);

    const port = Number(options.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid gateway port: ${options.port}`);
    }
    const token = typeof options.token === "string" ? options.token.trim() : "";
    if (!token) {
      throw new Error("gateway token is required");
    }

    const connectTimeoutMs = Math.max(500, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    const requestTimeoutMs = Math.max(500, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const ws = new WebSocket(`ws://${host}:${port}`);

    const client = new GatewayClient(ws, {
      connectTimeoutMs,
      requestTimeoutMs,
      token,
      clientId: options.clientId ?? "brewva-cli",
      clientVersion: options.clientVersion ?? "0.1.0",
      clientMode: options.clientMode,
    });

    try {
      await withTimeout(
        client.openDeferred.promise,
        connectTimeoutMs,
        "gateway connection timeout while opening socket",
      );
      const nonce = await withTimeout(
        client.challengeDeferred.promise,
        connectTimeoutMs,
        "gateway connection timeout waiting for challenge",
      );
      await client.performConnectHandshake(nonce);
      return client;
    } catch (error) {
      await client.close(300).catch(() => undefined);
      throw error;
    }
  }

  async request<K extends GatewayMethod>(
    method: K,
    params: GatewayParamsByMethod[K],
    options: {
      traceId?: string;
    } = {},
  ): Promise<unknown> {
    if (!this.ready) {
      throw new Error("gateway client is not ready");
    }
    const response = await this.sendRequest(method, params, this.requestTimeoutMs, options.traceId);
    if (response.ok) {
      return response.payload;
    }
    throw toErrorFromGatewayShape(response.error);
  }

  onEvent(listener: GatewayClientEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async close(timeoutMs = 2_000): Promise<void> {
    if (this.closed) {
      await this.closeDeferred.promise.catch(() => undefined);
      return;
    }

    this.closed = true;
    try {
      this.ws.close(1000, "client_close");
    } catch {
      // best effort
    }

    try {
      await withTimeout(this.closeDeferred.promise, timeoutMs, "gateway close timeout");
    } catch {
      this.ws.terminate();
      await this.closeDeferred.promise.catch(() => undefined);
    }
  }

  private attachSocketListeners(): void {
    this.ws.on("open", () => {
      this.openDeferred.resolve(undefined);
    });

    this.ws.on("message", (raw: RawData) => {
      this.onMessage(raw);
    });

    this.ws.on("close", () => {
      this.failAllPending(new Error("gateway socket closed"));
      this.closeDeferred.resolve(undefined);
    });

    this.ws.on("error", (error: Error) => {
      if (!this.openDeferred.settled()) {
        this.openDeferred.reject(error);
      }
      if (!this.challengeDeferred.settled()) {
        this.challengeDeferred.reject(error);
      }
      this.failAllPending(error);
    });
  }

  private onMessage(raw: RawData): void {
    const text = rawToText(raw);
    const parsedRaw = safeParseJson(text);
    if (!validateGatewayFrame(parsedRaw)) {
      return;
    }
    const parsed = parsedRaw as GatewayEventFrame | GatewayResponseFrame;

    if (parsed.type === "event") {
      if (parsed.event === "connect.challenge" && !this.challengeDeferred.settled()) {
        const payload = parsed.payload as { nonce?: unknown } | undefined;
        const nonce = typeof payload?.nonce === "string" ? payload.nonce : "";
        if (!nonce) {
          this.challengeDeferred.reject(new Error("invalid connect.challenge payload"));
        } else {
          this.challengeDeferred.resolve(nonce);
        }
      }
      this.emitEvent(parsed);
      return;
    }

    if (parsed.type !== "res") {
      return;
    }

    const response = parsed;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private async performConnectHandshake(challengeNonce: string): Promise<void> {
    const response = await this.sendRequest(
      "connect",
      {
        protocol: PROTOCOL_VERSION,
        client: {
          id: this.options.clientId,
          version: this.options.clientVersion,
          mode: this.options.clientMode,
        },
        auth: { token: this.options.token },
        challengeNonce,
      },
      this.options.connectTimeoutMs,
      undefined,
    );

    if (!response.ok) {
      throw toErrorFromGatewayShape(response.error);
    }
    this.ready = true;
  }

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
    traceId?: string,
  ): Promise<GatewayResponseFrame> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway socket is not open");
    }

    const id = randomUUID();
    const frame = JSON.stringify({
      type: "req",
      id,
      traceId: typeof traceId === "string" && traceId.trim() ? traceId.trim() : undefined,
      method,
      params,
    });

    return new Promise<GatewayResponseFrame>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          rejectRequest(new Error(`gateway request timeout: ${method}`));
        },
        Math.max(100, timeoutMs),
      );
      timer.unref?.();

      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });

      this.ws.send(frame, (error?: Error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(new Error(`failed to send gateway request: ${toErrorMessage(error)}`));
      });
    });
  }

  private failAllPending(error: unknown): void {
    const message = toErrorMessage(error);
    if (!this.challengeDeferred.settled()) {
      this.challengeDeferred.reject(new Error(message));
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private emitEvent(event: GatewayEventFrame): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // isolate listener errors from socket loop
      }
    }
  }
}

export async function connectGatewayClient(
  options: GatewayClientConnectOptions,
): Promise<GatewayClient> {
  return await GatewayClient.connect(options);
}
