import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnWALRecord } from "@brewva/brewva-runtime";
import { TurnWALRecovery, TurnWALStore, type TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type {
  ParentToWorkerMessage,
  WorkerResultErrorCode,
  WorkerToParentMessage,
} from "../session/worker-protocol.js";
import {
  FileGatewayStateStore,
  type ChildRegistryEntry,
  type GatewayStateStore,
} from "../state-store.js";
import { sleep } from "../utils/async.js";
import { createDeferred, type Deferred } from "../utils/deferred.js";
import { toErrorMessage } from "../utils/errors.js";
import type { StructuredLogger } from "./logger.js";
import { isProcessAlive } from "./pid.js";
import {
  type OpenSessionInput,
  type OpenSessionResult,
  type SessionBackend,
  SessionBackendCapacityError,
  SessionBackendStateError,
  type SendPromptOptions,
  type SendPromptOutput,
  type SendPromptResult,
  type SessionWorkerInfo,
} from "./session-backend.js";

const WORKER_RPC_TIMEOUT_MS = 5 * 60_000;
const WORKER_READY_TIMEOUT_MS = 30_000;
const BRIDGE_PING_INTERVAL_MS = 4_000;
const BRIDGE_HEARTBEAT_TIMEOUT_MS = 20_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WORKERS = 16;
const DEFAULT_MAX_PENDING_SESSION_OPENS = 64;
const DEFAULT_TURN_WAL_COMPACT_INTERVAL_MS = 120_000;

type LoggerLike = Pick<StructuredLogger, "debug" | "info" | "warn" | "error" | "log">;

interface PendingRequest {
  resolve: (payload: Record<string, unknown> | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTurn {
  resolve: (payload: SendPromptOutput) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  walId?: string;
}

interface WorkerHandle {
  sessionId: string;
  child: ChildProcess;
  startedAt: number;
  lastActivityAt: number;
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  enableExtensions?: boolean;
  requestedAgentSessionId?: string;
  pending: Map<string, PendingRequest>;
  pendingTurns: Map<string, PendingTurn>;
  activeTurnWalIds: Map<string, string>;
  readyRequestId?: string;
  readyResolve?: (payload: WorkerReadyPayload) => void;
  readyReject?: (error: Error) => void;
  readyTimer?: ReturnType<typeof setTimeout>;
  lastHeartbeatAt: number;
}

interface WorkerReadyPayload {
  requestedSessionId: string;
  agentSessionId: string;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildGatewayTurnEnvelope(input: {
  sessionId: string;
  turnId: string;
  prompt: string;
  source: "gateway" | "heartbeat";
}): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: input.sessionId,
    turnId: input.turnId,
    channel: input.source === "heartbeat" ? "heartbeat" : "gateway",
    conversationId: input.sessionId,
    timestamp: Date.now(),
    parts: [{ type: "text", text: input.prompt }],
    meta: {
      source: input.source,
    },
  };
}

function extractPromptFromEnvelope(envelope: TurnEnvelope): string {
  const parts = envelope.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0);
  return parts.join("\n");
}

function toWorkerResultError(input: { error: string; errorCode?: WorkerResultErrorCode }): Error {
  if (input.errorCode === "session_busy") {
    return new SessionBackendStateError("session_busy", input.error);
  }
  return new Error(input.error);
}

async function terminatePid(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

export interface SessionSupervisorOptions {
  stateDir: string;
  logger: LoggerLike;
  defaultCwd: string;
  defaultConfigPath?: string;
  defaultModel?: string;
  defaultEnableExtensions?: boolean;
  sessionIdleTtlMs?: number;
  sessionIdleSweepIntervalMs?: number;
  maxWorkers?: number;
  maxPendingSessionOpens?: number;
  stateStore?: GatewayStateStore;
  turnWalStore?: TurnWALStore;
  turnWalCompactIntervalMs?: number;
  onWorkerEvent?: (event: Extract<WorkerToParentMessage, { kind: "event" }>) => void;
}

export interface SessionSupervisorTestPendingRequest {
  requestId: string;
  resolve?: (payload: Record<string, unknown> | undefined) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SessionSupervisorTestWorkerInput {
  sessionId: string;
  pid: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastActivityAt?: number;
  cwd?: string;
  agentSessionId?: string;
  pendingRequests?: SessionSupervisorTestPendingRequest[];
}

export interface SessionSupervisorTestHooks {
  seedWorker(input: SessionSupervisorTestWorkerInput): void;
  persistRegistry(): void;
  dispatchWorkerMessage(sessionId: string, message: WorkerToParentMessage): void;
}

export class SessionSupervisor implements SessionBackend {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly stateDir: string;
  private readonly childrenRegistryPath: string;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionIdleSweepIntervalMs: number;
  private readonly maxWorkers: number;
  private readonly maxPendingSessionOpens: number;
  private readonly stateStore: GatewayStateStore;
  private readonly turnWalStore?: TurnWALStore;
  private readonly turnWalCompactIntervalMs: number;
  private readonly pendingOpenWaiters: Deferred<void>[] = [];
  private pendingOpenReservations = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private turnWalCompactTimer: ReturnType<typeof setInterval> | null = null;
  private idleSweepInFlight = false;
  readonly testHooks: SessionSupervisorTestHooks = {
    seedWorker: (input) => {
      this.seedWorkerForTest(input);
    },
    persistRegistry: () => {
      this.persistRegistry();
    },
    dispatchWorkerMessage: (sessionId, message) => {
      this.dispatchWorkerMessageForTest(sessionId, message);
    },
  };

  constructor(private readonly options: SessionSupervisorOptions) {
    this.stateDir = resolve(options.stateDir);
    this.childrenRegistryPath = resolve(this.stateDir, "children.json");
    this.stateStore = options.stateStore ?? new FileGatewayStateStore();
    this.turnWalStore = options.turnWalStore;
    this.turnWalCompactIntervalMs = Math.max(
      30_000,
      options.turnWalCompactIntervalMs ?? DEFAULT_TURN_WAL_COMPACT_INTERVAL_MS,
    );
    this.sessionIdleTtlMs = Math.max(0, options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS);
    const defaultSweepIntervalMs = Math.min(
      DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS,
      Math.max(1_000, Math.floor(this.sessionIdleTtlMs / 2)),
    );
    this.sessionIdleSweepIntervalMs = Math.max(
      1_000,
      options.sessionIdleSweepIntervalMs ?? defaultSweepIntervalMs,
    );
    this.maxWorkers = Math.max(1, options.maxWorkers ?? DEFAULT_MAX_WORKERS);
    this.maxPendingSessionOpens = Math.max(
      0,
      options.maxPendingSessionOpens ?? DEFAULT_MAX_PENDING_SESSION_OPENS,
    );
    mkdirSync(this.stateDir, { recursive: true });
  }

  private seedWorkerForTest(input: SessionSupervisorTestWorkerInput): void {
    const now = Date.now();
    const pending = new Map<string, PendingRequest>();
    for (const request of input.pendingRequests ?? []) {
      pending.set(request.requestId, {
        resolve: request.resolve ?? (() => undefined),
        reject: request.reject ?? (() => undefined),
        timer: request.timer ?? setTimeout(() => undefined, WORKER_RPC_TIMEOUT_MS),
      });
    }

    for (const request of pending.values()) {
      request.timer.unref?.();
    }

    const child = {
      pid: input.pid,
      send: () => true,
      on: () => undefined,
    } as unknown as ChildProcess;

    this.workers.set(input.sessionId, {
      sessionId: input.sessionId,
      child,
      startedAt: input.startedAt ?? now,
      lastActivityAt: input.lastActivityAt ?? now,
      cwd: input.cwd,
      requestedAgentSessionId: input.agentSessionId,
      pending,
      pendingTurns: new Map<string, PendingTurn>(),
      activeTurnWalIds: new Map<string, string>(),
      lastHeartbeatAt: input.lastHeartbeatAt ?? now,
    });
  }

  private dispatchWorkerMessageForTest(sessionId: string, message: WorkerToParentMessage): void {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    this.onWorkerMessage(handle, message);
  }

  async start(): Promise<void> {
    await this.sweepOrphanedChildren();
    await this.recoverTurnWal();
    this.startBridgePing();
    this.startIdleSweep();
    this.startTurnWalCompaction();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    if (this.turnWalCompactTimer) {
      clearInterval(this.turnWalCompactTimer);
      this.turnWalCompactTimer = null;
    }

    await Promise.allSettled(
      [...this.workers.keys()].map(async (sessionId) => {
        await this.stopSession(sessionId, "shutdown", 5_000);
      }),
    );

    this.persistRegistry();
  }

  async sweepOrphanedChildren(): Promise<void> {
    const entries = this.readRegistry();
    if (entries.length === 0) {
      return;
    }

    for (const entry of entries) {
      if (entry.pid === process.pid) {
        continue;
      }
      if (!isProcessAlive(entry.pid)) {
        continue;
      }

      this.options.logger.warn("terminating orphan worker", {
        sessionId: entry.sessionId,
        pid: entry.pid,
      });
      await terminatePid(entry.pid);
    }

    this.persistRegistry();
  }

  async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    const existing = this.workers.get(input.sessionId);
    if (existing) {
      this.touchActivity(existing);
      return {
        sessionId: existing.sessionId,
        created: false,
        workerPid: existing.child.pid ?? 0,
        agentSessionId: existing.requestedAgentSessionId,
      };
    }

    await this.acquireOpenAdmission(input.sessionId);

    try {
      const existingAfterWait = this.workers.get(input.sessionId);
      if (existingAfterWait) {
        this.touchActivity(existingAfterWait);
        return {
          sessionId: existingAfterWait.sessionId,
          created: false,
          workerPid: existingAfterWait.child.pid ?? 0,
          agentSessionId: existingAfterWait.requestedAgentSessionId,
        };
      }

      const child = this.spawnWorker();
      const handle: WorkerHandle = {
        sessionId: input.sessionId,
        child,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        cwd: input.cwd,
        configPath: input.configPath,
        model: input.model,
        agentId: input.agentId,
        enableExtensions: input.enableExtensions,
        pending: new Map<string, PendingRequest>(),
        pendingTurns: new Map<string, PendingTurn>(),
        activeTurnWalIds: new Map<string, string>(),
        lastHeartbeatAt: Date.now(),
      };
      this.workers.set(input.sessionId, handle);
      this.attachWorkerListeners(handle);

      const requestId = randomUUID();
      const ready = new Promise<WorkerReadyPayload>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          handle.readyRequestId = undefined;
          handle.readyResolve = undefined;
          handle.readyReject = undefined;
          handle.readyTimer = undefined;
          rejectReady(new Error("worker init timeout"));
        }, WORKER_READY_TIMEOUT_MS);
        timer.unref?.();

        handle.readyRequestId = requestId;
        handle.readyResolve = resolveReady;
        handle.readyReject = rejectReady;
        handle.readyTimer = timer;
      });

      this.sendToWorker(handle, {
        kind: "init",
        requestId,
        payload: {
          sessionId: input.sessionId,
          cwd: input.cwd ?? this.options.defaultCwd,
          configPath: input.configPath ?? this.options.defaultConfigPath,
          model: input.model ?? this.options.defaultModel,
          agentId: input.agentId,
          enableExtensions: input.enableExtensions ?? this.options.defaultEnableExtensions,
          parentPid: process.pid,
        },
      });

      try {
        const readyPayload = await ready;
        handle.requestedAgentSessionId = readyPayload.agentSessionId;
        this.touchActivity(handle);
        this.persistRegistry();
        this.options.logger.info("worker session opened", {
          sessionId: input.sessionId,
          workerPid: child.pid,
          agentSessionId: readyPayload.agentSessionId,
        });
        return {
          sessionId: input.sessionId,
          created: true,
          workerPid: child.pid ?? 0,
          agentSessionId: readyPayload.agentSessionId,
        };
      } catch (error) {
        this.workers.delete(input.sessionId);
        await terminatePid(child.pid ?? 0);
        this.persistRegistry();
        this.notifyOpenQueue();
        throw error;
      }
    } finally {
      this.releaseOpenAdmission();
    }
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    options: SendPromptOptions = {},
  ): Promise<SendPromptResult> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    this.touchActivity(handle);

    const requestedTurnId = options.turnId?.trim() || randomUUID();
    if (handle.activeTurnWalIds.has(requestedTurnId)) {
      throw new SessionBackendStateError(
        "duplicate_active_turn_id",
        `duplicate active turn id: ${requestedTurnId}`,
      );
    }
    const source = options.source === "heartbeat" ? "heartbeat" : "gateway";
    const replayWalId = normalizeOptionalString(options.walReplayId);
    const waitForCompletion = options.waitForCompletion === true;
    const completionPromise = waitForCompletion
      ? this.registerPendingTurn(handle, requestedTurnId, WORKER_RPC_TIMEOUT_MS)
      : undefined;
    let walId = replayWalId;
    try {
      if (!walId && this.turnWalStore?.isEnabled) {
        const walRecord = this.turnWalStore.appendPending(
          buildGatewayTurnEnvelope({
            sessionId,
            turnId: requestedTurnId,
            prompt,
            source,
          }),
          source,
          {
            dedupeKey: `${source}:${sessionId}:${requestedTurnId}`,
          },
        );
        walId = walRecord.walId;
      }
      if (walId) {
        this.turnWalStore?.markInflight(walId);
        this.trackTurnWalId(handle, requestedTurnId, walId);
      }
    } catch (error) {
      this.untrackTurnWalId(handle, requestedTurnId);
      this.rejectPendingTurn(handle, requestedTurnId, error);
      throw error;
    }

    let acknowledgedTurnId = requestedTurnId;
    let agentSessionId = handle.requestedAgentSessionId;
    try {
      const ackPayload = await this.request(handle, {
        kind: "send",
        requestId: randomUUID(),
        payload: {
          prompt,
          turnId: requestedTurnId,
        },
      });

      if (
        ackPayload &&
        typeof ackPayload === "object" &&
        typeof ackPayload.turnId === "string" &&
        ackPayload.turnId.trim()
      ) {
        acknowledgedTurnId = ackPayload.turnId.trim();
      }
      if (
        ackPayload &&
        typeof ackPayload === "object" &&
        typeof ackPayload.agentSessionId === "string" &&
        ackPayload.agentSessionId.trim()
      ) {
        agentSessionId = ackPayload.agentSessionId.trim();
        handle.requestedAgentSessionId = agentSessionId;
      }
    } catch (error) {
      if (walId) {
        this.turnWalStore?.markFailed(walId, toErrorMessage(error));
      }
      this.untrackTurnWalId(handle, requestedTurnId);
      this.rejectPendingTurn(handle, requestedTurnId, error);
      throw error;
    }

    if (acknowledgedTurnId !== requestedTurnId) {
      this.rekeyTurnWalId(handle, requestedTurnId, acknowledgedTurnId);
      if (waitForCompletion && completionPromise) {
        this.rekeyPendingTurn(handle, requestedTurnId, acknowledgedTurnId);
      }
    }

    if (waitForCompletion && completionPromise) {
      const output = await completionPromise;
      return {
        sessionId,
        agentSessionId,
        turnId: acknowledgedTurnId,
        accepted: true,
        output,
      };
    }

    return {
      sessionId,
      agentSessionId,
      turnId: acknowledgedTurnId,
      accepted: true,
    };
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return false;
    }
    this.touchActivity(handle);

    await this.request(handle, {
      kind: "abort",
      requestId: randomUUID(),
    });
    return true;
  }

  async stopSession(sessionId: string, reason = "stop", timeoutMs = 5_000): Promise<boolean> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return false;
    }

    const requestId = randomUUID();
    try {
      await this.request(
        handle,
        {
          kind: "shutdown",
          requestId,
          payload: { reason },
        },
        timeoutMs,
      );
    } catch {
      // ignore and escalate kill
    }

    await terminatePid(handle.child.pid ?? 0);
    this.workers.delete(sessionId);
    this.persistRegistry();
    this.notifyOpenQueue();
    return true;
  }

  listWorkers(): SessionWorkerInfo[] {
    return [...this.workers.values()].map((handle) => ({
      sessionId: handle.sessionId,
      pid: handle.child.pid ?? 0,
      startedAt: handle.startedAt,
      lastHeartbeatAt: handle.lastHeartbeatAt,
      lastActivityAt: handle.lastActivityAt,
      pendingRequests: handle.pending.size + handle.pendingTurns.size,
      agentSessionId: handle.requestedAgentSessionId,
      cwd: handle.cwd,
    }));
  }

  private request(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
    timeoutMs = WORKER_RPC_TIMEOUT_MS,
  ): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(
        () => {
          handle.pending.delete(message.requestId);
          rejectRequest(new Error(`worker request timeout: ${message.kind}`));
        },
        Math.max(1000, timeoutMs),
      );
      timer.unref?.();

      handle.pending.set(message.requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });

      this.sendToWorker(handle, message);
    });
  }

  private registerPendingTurn(
    handle: WorkerHandle,
    turnId: string,
    timeoutMs: number,
  ): Promise<SendPromptOutput> {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) {
      throw new Error("turnId is required");
    }
    if (handle.pendingTurns.has(normalizedTurnId)) {
      throw new SessionBackendStateError(
        "duplicate_active_turn_id",
        `duplicate active turn id: ${normalizedTurnId}`,
      );
    }

    return new Promise<SendPromptOutput>((resolveTurn, rejectTurn) => {
      const timer = setTimeout(
        () => {
          handle.pendingTurns.delete(normalizedTurnId);
          rejectTurn(new Error(`worker turn timeout: ${normalizedTurnId}`));
        },
        Math.max(1_000, timeoutMs),
      );
      timer.unref?.();

      handle.pendingTurns.set(normalizedTurnId, {
        resolve: resolveTurn,
        reject: rejectTurn,
        timer,
      });
    });
  }

  private trackTurnWalId(handle: WorkerHandle, turnId: string, walId: string): void {
    handle.activeTurnWalIds.set(turnId, walId);
    const pending = handle.pendingTurns.get(turnId);
    if (pending) {
      pending.walId = walId;
    }
  }

  private untrackTurnWalId(handle: WorkerHandle, turnId: string): string | undefined {
    const walId = handle.activeTurnWalIds.get(turnId);
    handle.activeTurnWalIds.delete(turnId);
    return walId;
  }

  private rekeyTurnWalId(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void {
    if (fromTurnId === toTurnId) {
      return;
    }
    const walId = handle.activeTurnWalIds.get(fromTurnId);
    if (!walId) {
      return;
    }
    handle.activeTurnWalIds.delete(fromTurnId);
    handle.activeTurnWalIds.set(toTurnId, walId);
  }

  private markTurnWalDone(handle: WorkerHandle, turnId: string): void {
    const walId = this.untrackTurnWalId(handle, turnId);
    if (!walId) return;
    this.turnWalStore?.markDone(walId);
  }

  private markTurnWalFailed(handle: WorkerHandle, turnId: string, error?: string): void {
    const walId = this.untrackTurnWalId(handle, turnId);
    if (!walId) return;
    this.turnWalStore?.markFailed(walId, error);
  }

  private rekeyPendingTurn(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void {
    if (fromTurnId === toTurnId) {
      return;
    }
    const pending = handle.pendingTurns.get(fromTurnId);
    if (!pending) {
      return;
    }
    handle.pendingTurns.delete(fromTurnId);
    handle.pendingTurns.set(toTurnId, pending);
  }

  private resolvePendingTurn(
    handle: WorkerHandle,
    turnId: string,
    payload: SendPromptOutput,
  ): void {
    const pending = handle.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    handle.pendingTurns.delete(turnId);
    pending.resolve(payload);
    this.touchActivity(handle);
  }

  private rejectPendingTurn(handle: WorkerHandle, turnId: string, error: unknown): void {
    const pending = handle.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    handle.pendingTurns.delete(turnId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.touchActivity(handle);
  }

  private spawnWorker(): ChildProcess {
    const workerModulePath = fileURLToPath(new URL("../session/worker-main.js", import.meta.url));
    return fork(workerModulePath, {
      cwd: this.options.defaultCwd,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        BREWVA_GATEWAY_WORKER: "1",
      },
      execArgv: [],
    });
  }

  private attachWorkerListeners(handle: WorkerHandle): void {
    handle.child.on("message", (message) => {
      this.onWorkerMessage(handle, message);
    });

    handle.child.on("exit", (code, signal) => {
      this.options.logger.info("worker exited", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        code,
        signal,
      });
      this.failAllPending(handle, new Error("worker exited"));
      this.workers.delete(handle.sessionId);
      this.persistRegistry();
      this.notifyOpenQueue();
    });

    handle.child.on("error", (error) => {
      this.options.logger.error("worker error", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        error: error.message,
      });
    });
  }

  private onWorkerMessage(handle: WorkerHandle, raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const message = raw as WorkerToParentMessage;

    if (message.kind === "bridge.heartbeat") {
      handle.lastHeartbeatAt = message.ts;
      return;
    }

    if (message.kind === "log") {
      const baseFields = {
        sessionId: handle.sessionId,
        workerPid: handle.child.pid ?? null,
      };
      this.options.logger.log(
        message.level,
        message.message,
        message.fields ? { ...baseFields, ...message.fields } : baseFields,
      );
      return;
    }

    if (message.kind === "ready") {
      if (handle.readyRequestId === message.requestId) {
        if (handle.readyTimer) {
          clearTimeout(handle.readyTimer);
          handle.readyTimer = undefined;
        }
        const resolveReady = handle.readyResolve;
        handle.readyRequestId = undefined;
        handle.readyResolve = undefined;
        handle.readyReject = undefined;
        this.touchActivity(handle);
        resolveReady?.(message.payload);
      }
      return;
    }

    if (message.kind === "event") {
      if (message.event === "session.turn.end") {
        this.markTurnWalDone(handle, message.payload.turnId);
        this.resolvePendingTurn(handle, message.payload.turnId, {
          assistantText: message.payload.assistantText,
          toolOutputs: message.payload.toolOutputs,
        });
      } else if (message.event === "session.turn.error") {
        this.markTurnWalFailed(handle, message.payload.turnId, message.payload.message);
        this.rejectPendingTurn(handle, message.payload.turnId, message.payload.message);
      }
      this.options.onWorkerEvent?.(message);
      return;
    }

    if (message.kind === "result") {
      if (handle.readyRequestId === message.requestId && !message.ok) {
        if (handle.readyTimer) {
          clearTimeout(handle.readyTimer);
          handle.readyTimer = undefined;
        }
        const rejectReady = handle.readyReject;
        handle.readyRequestId = undefined;
        handle.readyResolve = undefined;
        handle.readyReject = undefined;
        rejectReady?.(new Error(message.error));
        return;
      }

      const pending = handle.pending.get(message.requestId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      handle.pending.delete(message.requestId);
      this.touchActivity(handle);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(toWorkerResultError(message));
      }
    }
  }

  private failAllPending(handle: WorkerHandle, error: Error): void {
    if (handle.readyTimer) {
      clearTimeout(handle.readyTimer);
      handle.readyTimer = undefined;
    }
    if (handle.readyReject) {
      handle.readyReject(error);
      handle.readyReject = undefined;
      handle.readyResolve = undefined;
      handle.readyRequestId = undefined;
    }

    for (const pending of handle.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    handle.pending.clear();

    for (const pendingTurn of handle.pendingTurns.values()) {
      clearTimeout(pendingTurn.timer);
      pendingTurn.reject(error);
    }
    handle.pendingTurns.clear();

    for (const [, walId] of handle.activeTurnWalIds) {
      this.turnWalStore?.markFailed(walId, `worker_crash:${error.message}`);
    }
    handle.activeTurnWalIds.clear();
  }

  private sendToWorker(handle: WorkerHandle, message: ParentToWorkerMessage): void {
    handle.child.send(message);
  }

  private async acquireOpenAdmission(sessionId: string): Promise<void> {
    while (this.workers.size + this.pendingOpenReservations >= this.maxWorkers) {
      if (this.maxPendingSessionOpens <= 0) {
        throw new SessionBackendCapacityError(
          "worker_limit",
          `session worker limit reached: ${this.maxWorkers}`,
          {
            maxWorkers: this.maxWorkers,
            currentWorkers: this.workers.size,
            queueDepth: this.pendingOpenWaiters.length,
            maxQueueDepth: this.maxPendingSessionOpens,
          },
        );
      }
      if (this.pendingOpenWaiters.length >= this.maxPendingSessionOpens) {
        throw new SessionBackendCapacityError(
          "open_queue_full",
          `session open queue full: ${this.maxPendingSessionOpens}`,
          {
            maxWorkers: this.maxWorkers,
            currentWorkers: this.workers.size,
            queueDepth: this.pendingOpenWaiters.length,
            maxQueueDepth: this.maxPendingSessionOpens,
          },
        );
      }

      this.options.logger.warn("session open waiting for worker capacity", {
        sessionId,
        maxWorkers: this.maxWorkers,
        currentWorkers: this.workers.size,
        queueDepth: this.pendingOpenWaiters.length + 1,
      });
      const waiter = createDeferred<void>();
      this.pendingOpenWaiters.push(waiter);
      await waiter.promise;
    }
    this.pendingOpenReservations += 1;
  }

  private releaseOpenAdmission(): void {
    if (this.pendingOpenReservations > 0) {
      this.pendingOpenReservations -= 1;
    }
    this.notifyOpenQueue();
  }

  private notifyOpenQueue(): void {
    if (this.pendingOpenWaiters.length === 0) {
      return;
    }
    if (this.workers.size + this.pendingOpenReservations >= this.maxWorkers) {
      return;
    }
    const next = this.pendingOpenWaiters.shift();
    next?.resolve(undefined);
  }

  private touchActivity(handle: WorkerHandle): void {
    handle.lastActivityAt = Date.now();
  }

  private startBridgePing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const now = Date.now();

      for (const handle of this.workers.values()) {
        if (now - handle.lastHeartbeatAt > BRIDGE_HEARTBEAT_TIMEOUT_MS) {
          this.options.logger.warn("worker heartbeat timeout", {
            sessionId: handle.sessionId,
            pid: handle.child.pid,
          });
          void this.stopSession(handle.sessionId, "heartbeat_timeout");
          continue;
        }

        this.sendToWorker(handle, {
          kind: "bridge.ping",
          ts: now,
        });
      }
    }, BRIDGE_PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private startIdleSweep(): void {
    if (this.sessionIdleTtlMs <= 0 || this.idleSweepTimer) {
      return;
    }

    this.idleSweepTimer = setInterval(() => {
      if (this.idleSweepInFlight) {
        return;
      }
      this.idleSweepInFlight = true;
      void this.sweepIdleSessions()
        .catch((error: unknown) => {
          this.options.logger.warn("idle session sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.idleSweepInFlight = false;
        });
    }, this.sessionIdleSweepIntervalMs);
    this.idleSweepTimer.unref?.();
    this.options.logger.info("session idle sweep started", {
      ttlMs: this.sessionIdleTtlMs,
      intervalMs: this.sessionIdleSweepIntervalMs,
    });
  }

  private async sweepIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const handle of this.workers.values()) {
      if (handle.pending.size > 0 || handle.pendingTurns.size > 0 || handle.readyRequestId) {
        continue;
      }
      const idleMs = now - handle.lastActivityAt;
      if (idleMs < this.sessionIdleTtlMs) {
        continue;
      }

      this.options.logger.info("stopping idle worker session", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        idleMs,
        ttlMs: this.sessionIdleTtlMs,
      });
      try {
        await this.stopSession(handle.sessionId, "idle_timeout");
      } catch (error) {
        this.options.logger.warn("failed to stop idle worker session", {
          sessionId: handle.sessionId,
          pid: handle.child.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async recoverTurnWal(): Promise<void> {
    if (!this.turnWalStore?.isEnabled) {
      return;
    }
    const recovery = new TurnWALRecovery({
      workspaceRoot: this.turnWalStore.workspaceRoot,
      config: this.turnWalStore.config,
      scopeFilter: (scope) => scope === this.turnWalStore?.scope,
      handlers: {
        gateway: async ({ record }) => {
          await this.replayRecoveredTurn(record);
        },
        heartbeat: async ({ record }) => {
          await this.replayRecoveredTurn(record);
        },
      },
    });

    const summary = await recovery.recover();
    if (summary.scanned > 0 || summary.retried > 0 || summary.failed > 0 || summary.expired > 0) {
      this.options.logger.info("turn wal recovery completed", {
        scope: this.turnWalStore.scope,
        scanned: summary.scanned,
        retried: summary.retried,
        failed: summary.failed,
        expired: summary.expired,
        skipped: summary.skipped,
      });
    }
  }

  private async replayRecoveredTurn(record: TurnWALRecord): Promise<void> {
    const source = record.source === "heartbeat" ? "heartbeat" : "gateway";
    const sessionId = normalizeOptionalString(record.envelope.sessionId) ?? record.sessionId;
    const prompt = extractPromptFromEnvelope(record.envelope);
    if (!sessionId || !prompt) {
      this.turnWalStore?.markFailed(record.walId, "recovery_missing_prompt_or_session");
      return;
    }

    await this.openSession({ sessionId });
    await this.sendPrompt(sessionId, prompt, {
      turnId: record.turnId,
      source,
      walReplayId: record.walId,
      waitForCompletion: false,
    });
  }

  private startTurnWalCompaction(): void {
    if (!this.turnWalStore?.isEnabled || this.turnWalCompactTimer) {
      return;
    }
    this.turnWalCompactTimer = setInterval(() => {
      try {
        const result = this.turnWalStore?.compact();
        if (result && result.dropped > 0) {
          this.options.logger.debug("turn wal compacted", {
            scope: this.turnWalStore?.scope,
            scanned: result.scanned,
            retained: result.retained,
            dropped: result.dropped,
          });
        }
      } catch (error) {
        this.options.logger.warn("turn wal compact failed", {
          error: toErrorMessage(error),
        });
      }
    }, this.turnWalCompactIntervalMs);
    this.turnWalCompactTimer.unref?.();
  }

  private readRegistry(): ChildRegistryEntry[] {
    return this.stateStore.readChildrenRegistry(this.childrenRegistryPath);
  }

  private persistRegistry(): void {
    const rows: ChildRegistryEntry[] = [...this.workers.values()]
      .map((handle) => ({
        sessionId: handle.sessionId,
        pid: handle.child.pid ?? 0,
        startedAt: handle.startedAt,
      }))
      .filter((row) => row.pid > 0);

    if (rows.length === 0) {
      this.stateStore.removeChildrenRegistry(this.childrenRegistryPath);
      return;
    }

    try {
      this.stateStore.writeChildrenRegistry(this.childrenRegistryPath, rows);
    } catch (error) {
      this.options.logger.warn("failed to persist worker registry", {
        path: this.childrenRegistryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
