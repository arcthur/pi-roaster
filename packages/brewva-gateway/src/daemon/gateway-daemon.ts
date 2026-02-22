import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { loadOrCreateGatewayToken, rotateGatewayToken } from "../auth.js";
import { assertLoopbackHost, normalizeGatewayHost } from "../network.js";
import type { GatewayErrorShape } from "../protocol/index.js";
import {
  ErrorCodes,
  type ConnectParams,
  type GatewayEvent,
  type GatewayMethod,
  type RequestFrame,
  GatewayEvents,
  GatewayMethods,
  PROTOCOL_VERSION,
  gatewayError,
} from "../protocol/index.js";
import { validateParamsForMethod, validateRequestFrame } from "../protocol/validate.js";
import { FileGatewayStateStore, type GatewayStateStore } from "../state-store.js";
import { safeParseJson } from "../utils/json.js";
import { HeartbeatScheduler, type HeartbeatRule } from "./heartbeat-policy.js";
import { StructuredLogger } from "./logger.js";
import { readPidRecord, removePidRecord, writePidRecord, type GatewayPidRecord } from "./pid.js";
import {
  isSessionBackendCapacityError,
  isSessionBackendStateError,
  type SessionBackend,
  type SessionWorkerInfo,
} from "./session-backend.js";
import { SessionSupervisor } from "./session-supervisor.js";

const DEFAULT_PORT = 43111;
const DEFAULT_TICK_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_TICK_INTERVAL_MS = 15_000;
const WEBSOCKET_CLOSE_TIMEOUT_MS = 3_000;
const SESSION_SCOPED_EVENTS = new Set<GatewayEvent>([
  "session.turn.start",
  "session.turn.chunk",
  "session.turn.error",
  "session.turn.end",
]);

type ConnectionPhase = "connected" | "authenticating" | "authenticated" | "closing";

interface ConnectionState {
  connId: string;
  socket: WebSocket;
  challengeNonce: string;
  phase: ConnectionPhase;
  authenticatedToken?: string;
  subscribedSessions: Set<string>;
  connectedAt: number;
  lastSeenAt: number;
  client?: {
    id: string;
    version: string;
    mode?: string;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise;
    rejectValue = rejectPromise;
  });
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  };
}

function toMessageText(raw: RawData): string {
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

function isGatewayErrorShape(value: unknown): value is GatewayErrorShape {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<GatewayErrorShape>;
  return typeof row.code === "string" && typeof row.message === "string";
}

function ensureDirectoryCwd(cwd: string): void {
  const resolved = resolve(cwd);
  if (!existsSync(resolved)) {
    throw new Error(`session cwd does not exist: ${resolved}`);
  }
  const stats = statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`session cwd is not a directory: ${resolved}`);
  }
}

function isConnectionAuthenticated(state: ConnectionState): boolean {
  return state.phase === "authenticated";
}

function normalizeTraceId(traceId: unknown): string | undefined {
  if (typeof traceId !== "string") {
    return undefined;
  }
  const normalized = traceId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export interface GatewayDaemonOptions {
  host?: string;
  port?: number;
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  tokenFilePath: string;
  heartbeatPolicyPath: string;
  cwd: string;
  configPath?: string;
  model?: string;
  enableExtensions?: boolean;
  jsonStdout?: boolean;
  tickIntervalMs?: number;
  heartbeatTickIntervalMs?: number;
  sessionIdleTtlMs?: number;
  sessionIdleSweepIntervalMs?: number;
  maxWorkers?: number;
  maxPendingSessionOpens?: number;
  maxPayloadBytes?: number;
  sessionBackend?: SessionBackend;
  stateStore?: GatewayStateStore;
}

export interface GatewayRuntimeInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  heartbeatPolicyPath: string;
}

export interface GatewayHealthPayload {
  ok: true;
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  uptimeMs: number;
  connections: number;
  workers: number;
}

export interface GatewayStatusDeepPayload extends GatewayHealthPayload {
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  tokenFilePath: string;
  heartbeat: ReturnType<HeartbeatScheduler["getStatus"]>;
  workersDetail: SessionWorkerInfo[];
  connectionsDetail: Array<{
    connId: string;
    authenticated: boolean;
    phase: ConnectionPhase;
    connectedAt: number;
    lastSeenAt: number;
    subscribedSessions: string[];
    client?: {
      id: string;
      version: string;
      mode?: string;
    };
  }>;
}

export class GatewayDaemon {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly stateDir: string;
  private readonly pidFilePath: string;
  private readonly logFilePath: string;
  private readonly tokenFilePath: string;
  private readonly heartbeatPolicyPath: string;
  private readonly tickIntervalMs: number;
  private readonly maxPayloadBytes: number;
  private authToken: string;
  private readonly stateStore: GatewayStateStore;
  private readonly logger: StructuredLogger;
  private readonly supervisor: SessionBackend;
  private readonly heartbeatScheduler: HeartbeatScheduler;
  private readonly heartbeatSessionByRule = new Map<string, string>();
  private readonly startedAt = Date.now();
  private readonly stopDeferred = createDeferred<void>();
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly connectionsById = new Map<string, ConnectionState>();
  private readonly sessionSubscribers = new Map<string, Set<string>>();

  private wss: WebSocketServer | null = null;
  private currentPort: number;
  private eventSeq = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private ownsPidRecord = false;
  private onSigInt: (() => void) | null = null;
  private onSigTerm: (() => void) | null = null;

  constructor(private readonly options: GatewayDaemonOptions) {
    this.host = normalizeGatewayHost(options.host);
    assertLoopbackHost(this.host);

    this.configuredPort = Number.isInteger(options.port)
      ? Math.max(1, Number(options.port))
      : DEFAULT_PORT;
    this.currentPort = this.configuredPort;
    this.stateDir = resolve(options.stateDir);
    this.pidFilePath = resolve(options.pidFilePath);
    this.logFilePath = resolve(options.logFilePath);
    this.tokenFilePath = resolve(options.tokenFilePath);
    this.heartbeatPolicyPath = resolve(options.heartbeatPolicyPath);
    this.tickIntervalMs = Math.max(1000, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.maxPayloadBytes = Math.max(
      16 * 1024,
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    );
    this.stateStore = options.stateStore ?? new FileGatewayStateStore();

    ensureDirectoryCwd(options.cwd);
    this.authToken = loadOrCreateGatewayToken(this.tokenFilePath, this.stateStore);
    this.logger = new StructuredLogger({
      logFilePath: this.logFilePath,
      jsonStdout: options.jsonStdout === true,
    });

    this.supervisor =
      options.sessionBackend ??
      new SessionSupervisor({
        stateDir: this.stateDir,
        logger: this.logger,
        defaultCwd: resolve(options.cwd),
        defaultConfigPath: options.configPath,
        defaultModel: options.model,
        defaultEnableExtensions: options.enableExtensions,
        sessionIdleTtlMs: options.sessionIdleTtlMs,
        sessionIdleSweepIntervalMs: options.sessionIdleSweepIntervalMs,
        maxWorkers: options.maxWorkers,
        maxPendingSessionOpens: options.maxPendingSessionOpens,
        stateStore: this.stateStore,
        onWorkerEvent: (event) => {
          this.handleWorkerEvent(event.event, event.payload);
        },
      });

    this.heartbeatScheduler = new HeartbeatScheduler({
      sourcePath: this.heartbeatPolicyPath,
      logger: this.logger,
      tickIntervalMs:
        options.heartbeatTickIntervalMs !== undefined
          ? Math.max(1_000, options.heartbeatTickIntervalMs)
          : DEFAULT_HEARTBEAT_TICK_INTERVAL_MS,
      onFire: async (rule) => {
        await this.fireHeartbeat(rule);
      },
    });
    this.resetHeartbeatSessionMap(this.heartbeatScheduler.getStatus().rules);
  }

  async start(): Promise<void> {
    try {
      const pidRecord: GatewayPidRecord = {
        pid: process.pid,
        host: this.host,
        port: this.currentPort,
        startedAt: this.startedAt,
        cwd: resolve(this.options.cwd),
      };
      writePidRecord(this.pidFilePath, pidRecord);
      this.ownsPidRecord = true;

      await this.supervisor.start();
      this.heartbeatScheduler.start();
      this.startTickEmitter();
      this.installSignalHandlers();

      const wss = new WebSocketServer({
        host: this.host,
        port: this.configuredPort,
        maxPayload: this.maxPayloadBytes,
      });

      await new Promise<void>((resolveStart, rejectStart) => {
        const onError = (error: Error): void => {
          wss.off("listening", onListening);
          rejectStart(error);
        };
        const onListening = (): void => {
          wss.off("error", onError);
          resolveStart();
        };
        wss.once("error", onError);
        wss.once("listening", onListening);
      });

      wss.on("connection", (socket: WebSocket) => {
        this.onConnection(socket);
      });
      wss.on("error", (error: Error) => {
        this.logger.error("gateway websocket server error", { error: error.message });
      });
      this.wss = wss;

      const address = wss.address();
      if (address && typeof address === "object") {
        this.currentPort = address.port;
      }

      this.logger.info("gateway daemon started", {
        pid: process.pid,
        host: this.host,
        port: this.currentPort,
        stateDir: this.stateDir,
        heartbeatPolicyPath: this.heartbeatPolicyPath,
        protocol: PROTOCOL_VERSION,
      });
    } catch (error) {
      await this.cleanupFailedStart();
      throw error;
    }
  }

  getRuntimeInfo(): GatewayRuntimeInfo {
    return {
      pid: process.pid,
      host: this.host,
      port: this.currentPort,
      startedAt: this.startedAt,
      stateDir: this.stateDir,
      pidFilePath: this.pidFilePath,
      logFilePath: this.logFilePath,
      heartbeatPolicyPath: this.heartbeatPolicyPath,
    };
  }

  getHealthStatus(): GatewayHealthPayload {
    return {
      ok: true,
      pid: process.pid,
      host: this.host,
      port: this.currentPort,
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, Date.now() - this.startedAt),
      connections: [...this.connections.values()].filter((value) =>
        isConnectionAuthenticated(value),
      ).length,
      workers: this.supervisor.listWorkers().length,
    };
  }

  getDeepStatus(): GatewayStatusDeepPayload {
    return {
      ...this.getHealthStatus(),
      stateDir: this.stateDir,
      pidFilePath: this.pidFilePath,
      logFilePath: this.logFilePath,
      tokenFilePath: this.tokenFilePath,
      heartbeat: this.heartbeatScheduler.getStatus(),
      workersDetail: this.supervisor.listWorkers(),
      connectionsDetail: [...this.connections.values()].map((value) => ({
        connId: value.connId,
        authenticated: isConnectionAuthenticated(value),
        phase: value.phase,
        connectedAt: value.connectedAt,
        lastSeenAt: value.lastSeenAt,
        subscribedSessions: [...value.subscribedSessions],
        client: value.client,
      })),
    };
  }

  async waitForStop(): Promise<void> {
    await this.stopDeferred.promise;
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.stopping) {
      await this.stopDeferred.promise;
      return;
    }
    this.stopping = true;

    this.logger.info("gateway daemon stopping", { reason });
    this.broadcastEvent("shutdown", {
      reason,
      ts: Date.now(),
    });

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.heartbeatScheduler.stop();
    await this.supervisor.stop();

    if (this.wss) {
      const server = this.wss;
      this.wss = null;

      for (const state of Array.from(this.connections.values())) {
        this.cleanupConnectionState(state);
        try {
          state.socket.terminate();
        } catch {
          // best effort
        }
      }
      this.connections.clear();
      this.connectionsById.clear();
      this.sessionSubscribers.clear();

      await this.closeWebSocketServer(server, WEBSOCKET_CLOSE_TIMEOUT_MS);
    }

    this.uninstallSignalHandlers();
    this.removeOwnedPidRecordIfPresent();
    this.logger.info("gateway daemon stopped", { reason });
    this.stopDeferred.resolve(undefined);
  }

  private installSignalHandlers(): void {
    if (!this.onSigInt) {
      this.onSigInt = () => {
        void this.stop("sigint");
      };
      process.on("SIGINT", this.onSigInt);
    }
    if (!this.onSigTerm) {
      this.onSigTerm = () => {
        void this.stop("sigterm");
      };
      process.on("SIGTERM", this.onSigTerm);
    }
  }

  private uninstallSignalHandlers(): void {
    if (this.onSigInt) {
      process.off("SIGINT", this.onSigInt);
      this.onSigInt = null;
    }
    if (this.onSigTerm) {
      process.off("SIGTERM", this.onSigTerm);
      this.onSigTerm = null;
    }
  }

  private async cleanupFailedStart(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.heartbeatScheduler.stop();

    if (this.wss) {
      const server = this.wss;
      this.wss = null;
      await this.closeWebSocketServer(server, WEBSOCKET_CLOSE_TIMEOUT_MS);
    }

    await this.supervisor.stop().catch(() => undefined);
    this.uninstallSignalHandlers();
    this.removeOwnedPidRecordIfPresent();
  }

  private removeOwnedPidRecordIfPresent(): void {
    if (!this.ownsPidRecord) {
      return;
    }
    const currentRecord = readPidRecord(this.pidFilePath);
    if (currentRecord?.pid === process.pid) {
      removePidRecord(this.pidFilePath);
    }
    this.ownsPidRecord = false;
  }

  private startTickEmitter(): void {
    if (this.tickTimer) {
      return;
    }

    this.tickTimer = setInterval(() => {
      this.broadcastEvent("tick", {
        ts: Date.now(),
        workers: this.supervisor.listWorkers().length,
        connections: [...this.connections.values()].filter((value) =>
          isConnectionAuthenticated(value),
        ).length,
      });
    }, this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  private async closeWebSocketServer(server: WebSocketServer, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolveClose();
      };

      const timer = setTimeout(
        () => {
          this.logger.warn("gateway websocket close timeout", {
            timeoutMs,
            clients: server.clients.size,
          });
          finish();
        },
        Math.max(200, timeoutMs),
      );
      timer.unref?.();

      try {
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      } catch (error) {
        clearTimeout(timer);
        this.logger.warn("gateway websocket close threw error", {
          error: error instanceof Error ? error.message : String(error),
        });
        finish();
      }
    });
  }

  private nextEventSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  private onConnection(socket: WebSocket): void {
    const state: ConnectionState = {
      connId: randomUUID(),
      socket,
      challengeNonce: randomUUID(),
      phase: "connected",
      subscribedSessions: new Set<string>(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.connections.set(socket, state);
    this.connectionsById.set(state.connId, state);

    socket.on("message", (raw: RawData) => {
      void this.handleIncomingMessage(state, raw);
    });
    socket.on("close", () => {
      this.cleanupConnectionState(state);
    });
    socket.on("error", (error: Error) => {
      this.logger.warn("connection error", {
        connId: state.connId,
        error: error.message,
      });
    });

    this.sendEvent(state, "connect.challenge", {
      nonce: state.challengeNonce,
      ts: Date.now(),
    });
  }

  private async handleIncomingMessage(state: ConnectionState, raw: RawData): Promise<void> {
    state.lastSeenAt = Date.now();
    const text = toMessageText(raw);
    const parsedRaw = safeParseJson(text);
    if (!validateRequestFrame(parsedRaw)) {
      const id =
        parsedRaw &&
        typeof parsedRaw === "object" &&
        typeof (parsedRaw as { id?: unknown }).id === "string"
          ? (parsedRaw as { id: string }).id
          : randomUUID();
      this.sendResponse(state, {
        id,
        ok: false,
        traceId: undefined,
        error: gatewayError(
          ErrorCodes.INVALID_REQUEST,
          "invalid request frame; expected {type:'req',id,method,params}",
        ),
      });
      return;
    }

    const request = parsedRaw as RequestFrame;
    const methodRaw = request.method;
    if (!GatewayMethods.includes(methodRaw as GatewayMethod)) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId: normalizeTraceId(request.traceId),
        error: gatewayError(ErrorCodes.METHOD_NOT_FOUND, `method not found: ${methodRaw}`),
      });
      return;
    }
    const method = methodRaw as GatewayMethod;
    const traceId = normalizeTraceId(request.traceId);

    if (state.phase === "closing") {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.BAD_STATE, "connection is closing"),
      });
      return;
    }

    if (method !== "connect" && !isConnectionAuthenticated(state)) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.UNAUTHORIZED, "call connect first"),
      });
      return;
    }

    if (method === "connect" && isConnectionAuthenticated(state)) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.BAD_STATE, "connection already authenticated"),
      });
      return;
    }

    if (
      method !== "connect" &&
      isConnectionAuthenticated(state) &&
      state.authenticatedToken !== this.authToken
    ) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.UNAUTHORIZED, "invalid token"),
      });
      this.closeConnection(state, 1008, "auth token rotated");
      return;
    }

    const validated = validateParamsForMethod(method, request.params ?? {});
    if (!validated.ok) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.INVALID_REQUEST, validated.error),
      });
      return;
    }

    const startedAt = Date.now();
    this.logger.debug("gateway request received", {
      connId: state.connId,
      method,
      requestId: request.id,
      traceId,
      phase: state.phase,
    });

    try {
      const payload = await this.handleMethod(method, validated.params, state);
      this.sendResponse(state, {
        id: request.id,
        ok: true,
        traceId,
        payload,
      });
      this.logger.debug("gateway request completed", {
        connId: state.connId,
        method,
        requestId: request.id,
        traceId,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const shaped = isGatewayErrorShape(error)
        ? error
        : gatewayError(ErrorCodes.INTERNAL, toErrorMessage(error));
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: shaped,
      });
      this.logger.warn("gateway request failed", {
        connId: state.connId,
        method,
        requestId: request.id,
        traceId,
        latencyMs: Date.now() - startedAt,
        errorCode: shaped.code,
        errorMessage: shaped.message,
      });
    }
  }

  private async handleMethod(
    method: GatewayMethod,
    params: unknown,
    state: ConnectionState,
  ): Promise<unknown> {
    switch (method) {
      case "connect":
        return this.handleConnect(params as ConnectParams, state);
      case "health":
        return this.getHealthStatus();
      case "status.deep":
        return this.getDeepStatus();
      case "sessions.open": {
        const input = params as {
          sessionId?: string;
          cwd?: string;
          configPath?: string;
          model?: string;
          enableExtensions?: boolean;
        };
        const requestedSessionId = input.sessionId?.trim() || randomUUID();
        if (input.cwd) {
          ensureDirectoryCwd(input.cwd);
        }
        let result: Awaited<ReturnType<SessionBackend["openSession"]>>;
        try {
          result = await this.supervisor.openSession({
            sessionId: requestedSessionId,
            cwd: input.cwd ? resolve(input.cwd) : undefined,
            configPath: input.configPath,
            model: input.model,
            enableExtensions: input.enableExtensions,
          });
        } catch (error) {
          if (isSessionBackendCapacityError(error)) {
            throw gatewayError(ErrorCodes.BAD_STATE, error.message, {
              retryable: error.code === "worker_limit",
              details: {
                kind: error.code,
                ...error.details,
              },
            });
          }
          throw error;
        }
        return {
          ...result,
          requestedSessionId,
        };
      }
      case "sessions.subscribe": {
        const input = params as { sessionId: string };
        const sessionId = input.sessionId.trim();
        this.subscribeConnectionToSession(state, sessionId);
        return {
          sessionId,
          subscribed: true,
        };
      }
      case "sessions.unsubscribe": {
        const input = params as { sessionId: string };
        const sessionId = input.sessionId.trim();
        const unsubscribed = this.unsubscribeConnectionFromSession(state, sessionId);
        return {
          sessionId,
          unsubscribed,
        };
      }
      case "sessions.send": {
        const input = params as {
          sessionId: string;
          prompt: string;
          turnId?: string;
        };
        const sessionId = input.sessionId.trim();
        this.subscribeConnectionToSession(state, sessionId);

        let payload: Awaited<ReturnType<SessionBackend["sendPrompt"]>>;
        try {
          payload = await this.supervisor.sendPrompt(sessionId, input.prompt, {
            turnId: input.turnId,
            waitForCompletion: false,
          });
        } catch (error) {
          if (isSessionBackendStateError(error)) {
            throw gatewayError(ErrorCodes.BAD_STATE, toErrorMessage(error), {
              retryable: false,
              details: {
                kind: error.code,
              },
            });
          }
          throw error;
        }

        return {
          sessionId: payload.sessionId,
          agentSessionId: payload.agentSessionId,
          turnId: payload.turnId,
          accepted: payload.accepted,
        };
      }
      case "sessions.abort": {
        const input = params as { sessionId: string };
        const aborted = await this.supervisor.abortSession(input.sessionId);
        return {
          sessionId: input.sessionId,
          aborted,
        };
      }
      case "sessions.close": {
        const input = params as { sessionId: string };
        const closed = await this.supervisor.stopSession(input.sessionId, "remote_close");
        return {
          sessionId: input.sessionId,
          closed,
        };
      }
      case "heartbeat.reload": {
        const { policy, removedRuleIds, closedSessionIds } =
          await this.reloadHeartbeatPolicyAndCleanupSessions();
        return {
          sourcePath: policy.sourcePath,
          loadedAt: policy.loadedAt,
          rules: policy.rules.length,
          removedRules: removedRuleIds.length,
          closedSessions: closedSessionIds.length,
          removedRuleIds,
          closedSessionIds,
        };
      }
      case "gateway.rotate-token": {
        const previousToken = this.authToken;
        const rotatedAt = Date.now();
        const nextToken = rotateGatewayToken(this.tokenFilePath, this.stateStore);

        this.authToken = nextToken;
        const revokedConnections =
          previousToken && previousToken !== nextToken
            ? this.revokeAuthenticatedConnections(previousToken)
            : 0;

        this.logger.info("gateway auth token rotated", {
          connId: state.connId,
          rotatedAt,
          revokedConnections,
        });
        return {
          rotated: true,
          rotatedAt,
          revokedConnections,
        };
      }
      case "gateway.stop": {
        const input = params as { reason?: string };
        const reason = input.reason?.trim() || "remote_stop";
        setTimeout(() => {
          void this.stop(reason);
        }, 10).unref?.();
        return {
          stopping: true,
          reason,
        };
      }
      default:
        throw gatewayError(ErrorCodes.METHOD_NOT_FOUND, `method not found: ${String(method)}`);
    }
  }

  private handleConnect(params: ConnectParams, state: ConnectionState): unknown {
    state.phase = "authenticating";
    if (params.protocol !== PROTOCOL_VERSION) {
      state.phase = "connected";
      throw gatewayError(
        ErrorCodes.INVALID_REQUEST,
        `protocol mismatch: server=${PROTOCOL_VERSION}, client=${params.protocol}`,
      );
    }

    if (params.challengeNonce !== state.challengeNonce) {
      state.phase = "connected";
      throw gatewayError(
        ErrorCodes.UNAUTHORIZED,
        "challenge nonce mismatch; call connect.challenge first",
      );
    }

    const token = params.auth.token;
    if (token !== this.authToken) {
      state.phase = "connected";
      throw gatewayError(ErrorCodes.UNAUTHORIZED, "invalid token");
    }

    state.phase = "authenticated";
    state.authenticatedToken = token;
    state.client = {
      id: params.client.id,
      version: params.client.version,
      mode: params.client.mode,
    };

    return {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      server: {
        version: "0.1.0",
        connId: state.connId,
        pid: process.pid,
      },
      features: {
        methods: [...GatewayMethods],
        events: [...GatewayEvents],
      },
      policy: {
        maxPayloadBytes: this.maxPayloadBytes,
        tickIntervalMs: this.tickIntervalMs,
      },
    };
  }

  private async fireHeartbeat(rule: HeartbeatRule): Promise<void> {
    const sessionId =
      this.heartbeatSessionByRule.get(rule.id) ?? this.resolveHeartbeatSessionId(rule);
    this.heartbeatSessionByRule.set(rule.id, sessionId);
    await this.supervisor.openSession({ sessionId });
    const result = await this.supervisor.sendPrompt(sessionId, rule.prompt, {
      waitForCompletion: true,
    });

    this.broadcastEvent("heartbeat.fired", {
      ruleId: rule.id,
      sessionId,
      ts: Date.now(),
      hasResult: result.output !== undefined,
    });
  }

  private resolveHeartbeatSessionId(input: { id: string; sessionId?: string }): string {
    const explicitSessionId = input.sessionId?.trim();
    if (explicitSessionId) {
      return explicitSessionId;
    }
    return `heartbeat:${input.id}`;
  }

  private isDefaultHeartbeatSessionId(ruleId: string, sessionId: string): boolean {
    return sessionId === `heartbeat:${ruleId}`;
  }

  private resetHeartbeatSessionMap(rules: ReadonlyArray<{ id: string; sessionId?: string }>): void {
    this.heartbeatSessionByRule.clear();
    for (const rule of rules) {
      this.heartbeatSessionByRule.set(rule.id, this.resolveHeartbeatSessionId(rule));
    }
  }

  private async reloadHeartbeatPolicyAndCleanupSessions(): Promise<{
    policy: ReturnType<HeartbeatScheduler["reload"]>;
    removedRuleIds: string[];
    closedSessionIds: string[];
  }> {
    const previousSessionByRule = new Map(this.heartbeatSessionByRule);
    const policy = this.heartbeatScheduler.reload();
    this.resetHeartbeatSessionMap(policy.rules);

    const activeRuleIds = new Set(this.heartbeatSessionByRule.keys());
    const activeSessionIds = new Set(this.heartbeatSessionByRule.values());
    const removedRuleIds: string[] = [];
    const cleanupCandidates = new Set<string>();

    for (const [ruleId, previousSessionId] of previousSessionByRule.entries()) {
      if (!activeRuleIds.has(ruleId)) {
        removedRuleIds.push(ruleId);
        if (this.isDefaultHeartbeatSessionId(ruleId, previousSessionId)) {
          cleanupCandidates.add(previousSessionId);
        }
        continue;
      }

      const currentSessionId = this.heartbeatSessionByRule.get(ruleId);
      if (
        currentSessionId &&
        currentSessionId !== previousSessionId &&
        this.isDefaultHeartbeatSessionId(ruleId, previousSessionId)
      ) {
        cleanupCandidates.add(previousSessionId);
      }
    }

    const closedSessionIds: string[] = [];
    for (const sessionId of cleanupCandidates) {
      if (activeSessionIds.has(sessionId)) {
        continue;
      }
      const closed = await this.supervisor.stopSession(sessionId, "heartbeat_rule_removed");
      if (closed) {
        closedSessionIds.push(sessionId);
      }
    }

    if (removedRuleIds.length > 0 || closedSessionIds.length > 0) {
      this.logger.info("heartbeat policy cleanup completed", {
        removedRuleIds,
        closedSessionIds,
      });
    }

    return {
      policy,
      removedRuleIds,
      closedSessionIds,
    };
  }

  private handleWorkerEvent(event: GatewayEvent, payload: unknown): void {
    if (!SESSION_SCOPED_EVENTS.has(event)) {
      return;
    }
    const sessionId = this.extractSessionIdFromPayload(payload);
    if (!sessionId) {
      this.logger.warn("dropping session-scoped event without sessionId", { event });
      return;
    }
    this.broadcastSessionEvent(event, payload, sessionId);
  }

  private extractSessionIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const sessionId = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return undefined;
    }
    return sessionId.trim();
  }

  private subscribeConnectionToSession(state: ConnectionState, sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return false;
    }
    if (state.subscribedSessions.has(normalizedSessionId)) {
      return false;
    }
    state.subscribedSessions.add(normalizedSessionId);
    const subscribers = this.sessionSubscribers.get(normalizedSessionId);
    if (subscribers) {
      subscribers.add(state.connId);
    } else {
      this.sessionSubscribers.set(normalizedSessionId, new Set([state.connId]));
    }
    return true;
  }

  private unsubscribeConnectionFromSession(state: ConnectionState, sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || !state.subscribedSessions.has(normalizedSessionId)) {
      return false;
    }
    state.subscribedSessions.delete(normalizedSessionId);
    const subscribers = this.sessionSubscribers.get(normalizedSessionId);
    if (subscribers) {
      subscribers.delete(state.connId);
      if (subscribers.size === 0) {
        this.sessionSubscribers.delete(normalizedSessionId);
      }
    }
    return true;
  }

  private cleanupConnectionState(state: ConnectionState): void {
    this.transitionConnectionToClosing(state);
    this.connections.delete(state.socket);
    this.connectionsById.delete(state.connId);
  }

  private transitionConnectionToClosing(state: ConnectionState): void {
    if (state.phase === "closing") {
      return;
    }
    state.phase = "closing";
    for (const sessionId of Array.from(state.subscribedSessions)) {
      this.unsubscribeConnectionFromSession(state, sessionId);
    }
  }

  private broadcastSessionEvent(event: GatewayEvent, payload: unknown, sessionId: string): void {
    const subscriberIds = this.sessionSubscribers.get(sessionId);
    if (!subscriberIds || subscriberIds.size === 0) {
      return;
    }

    const seq = this.nextEventSeq();
    for (const connId of Array.from(subscriberIds)) {
      const state = this.connectionsById.get(connId);
      if (!state || !isConnectionAuthenticated(state)) {
        subscriberIds.delete(connId);
        continue;
      }
      this.sendEvent(state, event, payload, seq);
    }
    if (subscriberIds.size === 0) {
      this.sessionSubscribers.delete(sessionId);
    }
  }

  private revokeAuthenticatedConnections(token: string): number {
    let revokedConnections = 0;
    for (const state of this.connections.values()) {
      if (!isConnectionAuthenticated(state) || state.authenticatedToken !== token) {
        continue;
      }
      revokedConnections += 1;
      this.closeConnection(state, 1008, "auth token rotated");
    }
    return revokedConnections;
  }

  private closeConnection(state: ConnectionState, code: number, reason: string): void {
    this.transitionConnectionToClosing(state);
    setTimeout(() => {
      if (
        state.socket.readyState !== state.socket.OPEN &&
        state.socket.readyState !== state.socket.CONNECTING
      ) {
        return;
      }
      try {
        state.socket.close(code, reason);
      } catch {
        state.socket.terminate();
      }
    }, 10).unref?.();
  }

  private sendResponse(
    state: ConnectionState,
    payload: {
      id: string;
      ok: boolean;
      traceId?: string;
      payload?: unknown;
      error?: GatewayErrorShape;
    },
  ): void {
    if (state.socket.readyState !== state.socket.OPEN) {
      return;
    }

    const frame = {
      type: "res",
      id: payload.id,
      traceId: payload.traceId,
      ok: payload.ok,
      payload: payload.payload,
      error: payload.error,
    };
    state.socket.send(JSON.stringify(frame));
  }

  private sendEvent(
    state: ConnectionState,
    event: GatewayEvent,
    payload?: unknown,
    seq?: number,
  ): void {
    if (state.socket.readyState !== state.socket.OPEN) {
      return;
    }
    const frame = {
      type: "event",
      event,
      payload,
      seq: seq ?? this.nextEventSeq(),
    };
    state.socket.send(JSON.stringify(frame));
  }

  private broadcastEvent(event: GatewayEvent, payload?: unknown): void {
    if (SESSION_SCOPED_EVENTS.has(event)) {
      const sessionId = this.extractSessionIdFromPayload(payload);
      if (sessionId) {
        this.broadcastSessionEvent(event, payload, sessionId);
      } else {
        this.logger.warn("skipping scoped event broadcast without sessionId", { event });
      }
      return;
    }
    const seq = this.nextEventSeq();
    for (const state of this.connections.values()) {
      if (!isConnectionAuthenticated(state) && event !== "connect.challenge") {
        continue;
      }
      this.sendEvent(state, event, payload, seq);
    }
  }
}

export async function runGatewayDaemon(options: GatewayDaemonOptions): Promise<void> {
  const daemon = new GatewayDaemon(options);
  await daemon.start();
  await daemon.waitForStop();
}
