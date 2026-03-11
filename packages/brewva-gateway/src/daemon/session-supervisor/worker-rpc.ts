import type {
  ParentToWorkerMessage,
  WorkerToParentMessage,
} from "../../session/worker-protocol.js";
import { SessionBackendStateError } from "../session-backend.js";
import type { SendPromptOutput } from "../session-backend.js";
import {
  type WorkerHandle,
  type WorkerRpcControllerDeps,
  type WorkerRpcErrorInput,
} from "./worker-state.js";

const WORKER_RPC_TIMEOUT_MS = 5 * 60_000;

export function toWorkerResultError(input: WorkerRpcErrorInput): Error {
  if (input.errorCode === "session_busy") {
    return new SessionBackendStateError("session_busy", input.error);
  }
  return new Error(input.error);
}

export function extractBusyTurnId(error: unknown): string | undefined {
  if (!(error instanceof SessionBackendStateError) || error.code !== "session_busy") {
    return undefined;
  }
  const match = error.message.match(/active turn:\s*(.+)$/i);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export class SessionWorkerRpcController {
  constructor(private readonly deps: WorkerRpcControllerDeps) {}

  attachWorkerListeners(handle: WorkerHandle): void {
    handle.child.on("message", (message) => {
      this.handleWorkerMessage(handle, message);
    });

    handle.child.on("exit", (code, signal) => {
      this.deps.logger.info("worker exited", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        code,
        signal,
      });
      this.failAllPending(handle, new Error("worker exited"));
      this.deps.onWorkerExited(handle);
    });

    handle.child.on("error", (error) => {
      this.deps.logger.error("worker error", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        error: error.message,
      });
    });
  }

  request(
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
        Math.max(1_000, timeoutMs),
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

  registerPendingTurn(
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

    return new Promise((resolveTurn, rejectTurn) => {
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

  trackTurnWalId(handle: WorkerHandle, turnId: string, walId: string): void {
    handle.activeTurnWalIds.set(turnId, walId);
    const pending = handle.pendingTurns.get(turnId);
    if (pending) {
      pending.walId = walId;
    }
  }

  untrackTurnWalId(handle: WorkerHandle, turnId: string): string | undefined {
    const walId = handle.activeTurnWalIds.get(turnId);
    handle.activeTurnWalIds.delete(turnId);
    return walId;
  }

  rekeyTurnWalId(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void {
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

  markTurnWalDone(handle: WorkerHandle, turnId: string): void {
    const walId = this.untrackTurnWalId(handle, turnId);
    if (!walId) return;
    this.deps.turnWalStore?.markDone(walId);
  }

  markTurnWalFailed(handle: WorkerHandle, turnId: string, error?: string): void {
    const walId = this.untrackTurnWalId(handle, turnId);
    if (!walId) return;
    this.deps.turnWalStore?.markFailed(walId, error);
  }

  rekeyPendingTurn(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void {
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

  resolvePendingTurn(handle: WorkerHandle, turnId: string, payload: SendPromptOutput): void {
    const pending = handle.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    handle.pendingTurns.delete(turnId);
    pending.resolve(payload);
    this.deps.touchActivity(handle);
  }

  rejectPendingTurn(handle: WorkerHandle, turnId: string, error: unknown): void {
    const pending = handle.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    handle.pendingTurns.delete(turnId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.deps.touchActivity(handle);
  }

  failAllPending(handle: WorkerHandle, error: Error): void {
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

    for (const queued of handle.turnQueue) {
      queued.reject(error);
      if (queued.walId) {
        this.deps.turnWalStore?.markFailed(queued.walId, `worker_crash:${error.message}`);
      }
    }
    handle.turnQueue = [];

    for (const [, walId] of handle.activeTurnWalIds) {
      this.deps.turnWalStore?.markFailed(walId, `worker_crash:${error.message}`);
    }
    handle.activeTurnWalIds.clear();
    handle.activeTurnId = null;
  }

  handleWorkerMessage(handle: WorkerHandle, raw: unknown): void {
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
      this.deps.logger.log(
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
        this.deps.touchActivity(handle);
        resolveReady?.(message.payload);
      }
      return;
    }

    if (message.kind === "event") {
      if (message.event === "session.turn.start") {
        handle.activeTurnId = message.payload.turnId;
        this.deps.touchActivity(handle);
      } else if (message.event === "session.turn.end") {
        this.markTurnWalDone(handle, message.payload.turnId);
        this.resolvePendingTurn(handle, message.payload.turnId, {
          assistantText: message.payload.assistantText,
          toolOutputs: message.payload.toolOutputs,
        });
        if (handle.activeTurnId === message.payload.turnId) {
          handle.activeTurnId = null;
        }
        this.deps.onTurnQueueReady(handle);
      } else if (message.event === "session.turn.error") {
        this.markTurnWalFailed(handle, message.payload.turnId, message.payload.message);
        this.rejectPendingTurn(handle, message.payload.turnId, message.payload.message);
        if (handle.activeTurnId === message.payload.turnId) {
          handle.activeTurnId = null;
        }
        this.deps.onTurnQueueReady(handle);
      }
      this.deps.onWorkerEvent?.(message);
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
      this.deps.touchActivity(handle);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(toWorkerResultError(message));
      }
    }
  }

  private sendToWorker(handle: WorkerHandle, message: ParentToWorkerMessage): void {
    handle.child.send(message);
  }
}
