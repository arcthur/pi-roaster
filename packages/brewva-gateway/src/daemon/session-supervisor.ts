import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnWALRecord } from "@brewva/brewva-runtime";
import { TurnWALRecovery, TurnWALStore } from "@brewva/brewva-runtime/channels";
import type { WorkerToParentMessage } from "../session/worker-protocol.js";
import {
  FileGatewayStateStore,
  type ChildRegistryEntry,
  type GatewayStateStore,
} from "../state-store.js";
import { sleep } from "../utils/async.js";
import { toErrorMessage } from "../utils/errors.js";
import type { StructuredLogger } from "./logger.js";
import { isProcessAlive } from "./pid.js";
import {
  type OpenSessionInput,
  type OpenSessionResult,
  type SendPromptOptions,
  type SendPromptResult,
  type SessionBackend,
  SessionBackendStateError,
  type SessionWorkerInfo,
} from "./session-backend.js";
import { SessionOpenAdmissionController } from "./session-supervisor/admission.js";
import {
  buildSessionTurnEnvelope,
  extractPromptFromEnvelope,
  extractTriggerFromEnvelope,
  normalizeOptionalString,
} from "./session-supervisor/turn-envelope.js";
import { SessionTurnQueueCoordinator } from "./session-supervisor/turn-queue.js";
import { SessionWorkerRpcController } from "./session-supervisor/worker-rpc.js";
import {
  type PendingRequest,
  type PendingTurn,
  type WorkerHandle,
  type WorkerReadyPayload,
  isWorkerIdle,
  toRegistryEntries,
  toSessionWorkerInfo,
} from "./session-supervisor/worker-state.js";

const WORKER_READY_TIMEOUT_MS = 30_000;
const BRIDGE_PING_INTERVAL_MS = 4_000;
const BRIDGE_HEARTBEAT_TIMEOUT_MS = 20_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WORKERS = 16;
const DEFAULT_MAX_PENDING_SESSION_OPENS = 64;
const DEFAULT_MAX_PENDING_TURNS_PER_SESSION = 32;
const DEFAULT_TURN_WAL_COMPACT_INTERVAL_MS = 120_000;

type LoggerLike = Pick<StructuredLogger, "debug" | "info" | "warn" | "error" | "log">;

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
  workerEnv?: Record<string, string | undefined>;
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
  private readonly openAdmission: SessionOpenAdmissionController;
  private readonly workerRpc: SessionWorkerRpcController;
  private readonly turnQueue: SessionTurnQueueCoordinator;
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

    this.openAdmission = new SessionOpenAdmissionController({
      logger: this.options.logger,
      maxWorkers: this.maxWorkers,
      maxPendingSessionOpens: this.maxPendingSessionOpens,
      getCurrentWorkers: () => this.workers.size,
    });
    this.workerRpc = new SessionWorkerRpcController({
      logger: this.options.logger,
      turnWalStore: this.turnWalStore,
      onWorkerEvent: this.options.onWorkerEvent,
      touchActivity: (handle) => {
        this.touchActivity(handle);
      },
      onTurnQueueReady: (handle) => {
        void this.turnQueue.pump(handle);
      },
      onWorkerExited: (handle) => {
        this.onWorkerExited(handle);
      },
    });
    this.turnQueue = new SessionTurnQueueCoordinator({
      request: (handle, message, timeoutMs) => this.workerRpc.request(handle, message, timeoutMs),
      registerPendingTurn: (handle, turnId, timeoutMs) =>
        this.workerRpc.registerPendingTurn(handle, turnId, timeoutMs),
      rejectPendingTurn: (handle, turnId, error) =>
        this.workerRpc.rejectPendingTurn(handle, turnId, error),
      rekeyPendingTurn: (handle, fromTurnId, toTurnId) =>
        this.workerRpc.rekeyPendingTurn(handle, fromTurnId, toTurnId),
      trackTurnWalId: (handle, turnId, walId) =>
        this.workerRpc.trackTurnWalId(handle, turnId, walId),
      untrackTurnWalId: (handle, turnId) => this.workerRpc.untrackTurnWalId(handle, turnId),
      rekeyTurnWalId: (handle, fromTurnId, toTurnId) =>
        this.workerRpc.rekeyTurnWalId(handle, fromTurnId, toTurnId),
      markQueuedTurnInflight: (walId) => {
        this.turnWalStore?.markInflight(walId);
      },
      markTurnWalFailed: (handle, turnId, error) =>
        this.workerRpc.markTurnWalFailed(handle, turnId, error),
    });

    mkdirSync(this.stateDir, { recursive: true });
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

    await this.openAdmission.acquire(input.sessionId);

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
        turnQueue: [],
        activeTurnId: null,
        activeTurnWalIds: new Map<string, string>(),
        lastHeartbeatAt: Date.now(),
      };
      this.workers.set(input.sessionId, handle);
      this.workerRpc.attachWorkerListeners(handle);

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

      handle.child.send({
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
        throw error;
      }
    } finally {
      this.openAdmission.release();
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
    if (this.turnQueue.hasOutstandingTurn(handle, requestedTurnId)) {
      throw new SessionBackendStateError(
        "duplicate_active_turn_id",
        `duplicate active turn id: ${requestedTurnId}`,
      );
    }
    if (handle.turnQueue.length >= DEFAULT_MAX_PENDING_TURNS_PER_SESSION) {
      throw new SessionBackendStateError(
        "session_busy",
        `session queue full for ${sessionId}: ${DEFAULT_MAX_PENDING_TURNS_PER_SESSION}`,
      );
    }

    const source = options.source ?? "gateway";
    const replayWalId = normalizeOptionalString(options.walReplayId);
    const waitForCompletion = options.waitForCompletion === true;
    let walId = replayWalId;
    if (!walId && this.turnWalStore?.isEnabled) {
      const walRecord = this.turnWalStore.appendPending(
        buildSessionTurnEnvelope({
          sessionId,
          turnId: requestedTurnId,
          prompt,
          source,
          trigger: options.trigger,
        }),
        source,
        {
          dedupeKey: `${source}:${sessionId}:${requestedTurnId}`,
        },
      );
      walId = walRecord.walId;
    }

    const queued = new Promise<SendPromptResult>((resolveQueued, rejectQueued) => {
      handle.turnQueue.push({
        requestedTurnId,
        prompt,
        source,
        trigger: options.trigger,
        waitForCompletion,
        walId,
        resolve: resolveQueued,
        reject: rejectQueued,
      });
    });
    void this.turnQueue.pump(handle);
    return queued;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return false;
    }
    this.touchActivity(handle);

    await this.workerRpc.request(handle, {
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

    try {
      await this.workerRpc.request(
        handle,
        {
          kind: "shutdown",
          requestId: randomUUID(),
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
    this.openAdmission.notifyIfAvailable();
    return true;
  }

  listWorkers(): SessionWorkerInfo[] {
    return [...this.workers.values()].map((handle) => toSessionWorkerInfo(handle));
  }

  private seedWorkerForTest(input: SessionSupervisorTestWorkerInput): void {
    const now = Date.now();
    const pending = new Map<string, PendingRequest>();
    for (const request of input.pendingRequests ?? []) {
      pending.set(request.requestId, {
        resolve: request.resolve ?? (() => undefined),
        reject: request.reject ?? (() => undefined),
        timer: request.timer ?? setTimeout(() => undefined, 5 * 60_000),
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
      turnQueue: [],
      activeTurnId: null,
      activeTurnWalIds: new Map<string, string>(),
      lastHeartbeatAt: input.lastHeartbeatAt ?? now,
    });
  }

  private dispatchWorkerMessageForTest(sessionId: string, message: WorkerToParentMessage): void {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    this.workerRpc.handleWorkerMessage(handle, message);
  }

  private spawnWorker(): ChildProcess {
    const workerModulePath = fileURLToPath(new URL("../session/worker-main.js", import.meta.url));
    return fork(workerModulePath, {
      cwd: this.options.defaultCwd,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        ...this.options.workerEnv,
        BREWVA_GATEWAY_WORKER: "1",
      },
      execArgv: [],
    });
  }

  private onWorkerExited(handle: WorkerHandle): void {
    this.workers.delete(handle.sessionId);
    this.persistRegistry();
    this.openAdmission.notifyIfAvailable();
  }

  private touchActivity(handle: WorkerHandle): void {
    handle.lastActivityAt = Date.now();
  }

  private startBridgePing(): void {
    if (this.pingTimer) {
      return;
    }

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

        handle.child.send({
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
      if (!isWorkerIdle(handle)) {
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
        schedule: async ({ record }) => {
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
    const source =
      record.source === "heartbeat"
        ? "heartbeat"
        : record.source === "schedule"
          ? "schedule"
          : "gateway";
    const sessionId = normalizeOptionalString(record.envelope.sessionId) ?? record.sessionId;
    const prompt = extractPromptFromEnvelope(record.envelope);
    const trigger = extractTriggerFromEnvelope(record.envelope);
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
      trigger,
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
    const rows = toRegistryEntries(this.workers.values());
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
