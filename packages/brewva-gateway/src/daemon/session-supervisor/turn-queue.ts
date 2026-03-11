import { randomUUID } from "node:crypto";
import type { SendPromptOutput } from "../session-backend.js";
import { extractBusyTurnId } from "./worker-rpc.js";
import { type TurnQueueControllerDeps, type WorkerHandle } from "./worker-state.js";

const WORKER_RPC_TIMEOUT_MS = 5 * 60_000;

export class SessionTurnQueueCoordinator {
  constructor(private readonly deps: TurnQueueControllerDeps) {}

  hasOutstandingTurn(handle: WorkerHandle, turnId: string): boolean {
    if (handle.activeTurnId === turnId) {
      return true;
    }
    if (handle.activeTurnWalIds.has(turnId) || handle.pendingTurns.has(turnId)) {
      return true;
    }
    return handle.turnQueue.some((queued) => queued.requestedTurnId === turnId);
  }

  async pump(handle: WorkerHandle): Promise<void> {
    if (handle.activeTurnId || handle.turnQueue.length === 0) {
      return;
    }

    const queued = handle.turnQueue.shift();
    if (!queued) {
      return;
    }

    handle.activeTurnId = queued.requestedTurnId;
    let completionPromise: Promise<SendPromptOutput> | undefined;
    try {
      completionPromise = queued.waitForCompletion
        ? this.deps.registerPendingTurn(handle, queued.requestedTurnId, WORKER_RPC_TIMEOUT_MS)
        : undefined;
    } catch (error) {
      handle.activeTurnId = null;
      queued.reject(error instanceof Error ? error : new Error(String(error)));
      void this.pump(handle);
      return;
    }
    if (completionPromise) {
      void completionPromise.catch(() => undefined);
    }

    try {
      if (queued.walId) {
        this.deps.markQueuedTurnInflight(queued.walId);
        this.deps.trackTurnWalId(handle, queued.requestedTurnId, queued.walId);
      }
    } catch (error) {
      this.deps.rejectPendingTurn(handle, queued.requestedTurnId, error);
      queued.reject(error instanceof Error ? error : new Error(String(error)));
      handle.activeTurnId = null;
      void this.pump(handle);
      return;
    }

    let acknowledgedTurnId = queued.requestedTurnId;
    let agentSessionId = handle.requestedAgentSessionId;

    try {
      const ackPayload = await this.deps.request(handle, {
        kind: "send",
        requestId: randomUUID(),
        payload: {
          prompt: queued.prompt,
          turnId: queued.requestedTurnId,
          trigger: queued.trigger,
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
      const busyTurnId = extractBusyTurnId(error);
      if (busyTurnId && busyTurnId !== queued.requestedTurnId) {
        this.deps.untrackTurnWalId(handle, queued.requestedTurnId);
        this.deps.rejectPendingTurn(handle, queued.requestedTurnId, new Error("turn requeued"));
        handle.activeTurnId = busyTurnId;
        handle.turnQueue.unshift(queued);
        return;
      }

      if (queued.walId) {
        this.deps.markTurnWalFailed(
          handle,
          queued.requestedTurnId,
          error instanceof Error ? error.message : String(error),
        );
      }
      this.deps.rejectPendingTurn(handle, queued.requestedTurnId, error);
      queued.reject(error instanceof Error ? error : new Error(String(error)));
      handle.activeTurnId = null;
      void this.pump(handle);
      return;
    }

    if (acknowledgedTurnId !== queued.requestedTurnId) {
      this.deps.rekeyTurnWalId(handle, queued.requestedTurnId, acknowledgedTurnId);
      if (completionPromise) {
        this.deps.rekeyPendingTurn(handle, queued.requestedTurnId, acknowledgedTurnId);
      }
    }
    handle.activeTurnId = acknowledgedTurnId;

    if (!queued.waitForCompletion) {
      queued.resolve({
        sessionId: handle.sessionId,
        agentSessionId,
        turnId: acknowledgedTurnId,
        accepted: true,
      });
      return;
    }

    if (!completionPromise) {
      queued.reject(new Error(`missing completion promise for ${acknowledgedTurnId}`));
      return;
    }

    void completionPromise
      .then((output) => {
        queued.resolve({
          sessionId: handle.sessionId,
          agentSessionId,
          turnId: acknowledgedTurnId,
          accepted: true,
          output,
        });
      })
      .catch((error: unknown) => {
        queued.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }
}
