import type { ChildProcess } from "node:child_process";
import type { TurnWALStore } from "@brewva/brewva-runtime/channels";
import type {
  ParentToWorkerMessage,
  WorkerResultErrorCode,
  WorkerToParentMessage,
} from "../../session/worker-protocol.js";
import type { ChildRegistryEntry } from "../../state-store.js";
import type { StructuredLogger } from "../logger.js";
import type {
  SendPromptOutput,
  SendPromptResult,
  SendPromptTrigger,
  SessionWorkerInfo,
} from "../session-backend.js";

export interface PendingRequest {
  resolve: (payload: Record<string, unknown> | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingTurn {
  resolve: (payload: SendPromptOutput) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  walId?: string;
}

export interface QueuedTurn {
  requestedTurnId: string;
  prompt: string;
  source: "gateway" | "heartbeat" | "schedule";
  trigger?: SendPromptTrigger;
  waitForCompletion: boolean;
  walId?: string;
  resolve: (result: SendPromptResult) => void;
  reject: (error: Error) => void;
}

export interface WorkerHandle {
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
  turnQueue: QueuedTurn[];
  activeTurnId: string | null;
  activeTurnWalIds: Map<string, string>;
  readyRequestId?: string;
  readyResolve?: (payload: WorkerReadyPayload) => void;
  readyReject?: (error: Error) => void;
  readyTimer?: ReturnType<typeof setTimeout>;
  lastHeartbeatAt: number;
}

export interface WorkerReadyPayload {
  requestedSessionId: string;
  agentSessionId: string;
}

export type LoggerLike = Pick<StructuredLogger, "debug" | "info" | "warn" | "error" | "log">;

export interface WorkerRpcControllerDeps {
  logger: LoggerLike;
  turnWalStore?: TurnWALStore;
  onWorkerEvent?: (event: Extract<WorkerToParentMessage, { kind: "event" }>) => void;
  touchActivity(handle: WorkerHandle): void;
  onTurnQueueReady(handle: WorkerHandle): void;
  onWorkerExited(handle: WorkerHandle): void;
}

export interface TurnQueueControllerDeps {
  request(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown> | undefined>;
  registerPendingTurn(
    handle: WorkerHandle,
    turnId: string,
    timeoutMs: number,
  ): Promise<SendPromptOutput>;
  rejectPendingTurn(handle: WorkerHandle, turnId: string, error: unknown): void;
  rekeyPendingTurn(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void;
  trackTurnWalId(handle: WorkerHandle, turnId: string, walId: string): void;
  untrackTurnWalId(handle: WorkerHandle, turnId: string): string | undefined;
  rekeyTurnWalId(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void;
  markQueuedTurnInflight(walId: string): void;
  markTurnWalFailed(handle: WorkerHandle, turnId: string, error?: string): void;
}

export interface WorkerRpcErrorInput {
  error: string;
  errorCode?: WorkerResultErrorCode;
}

export function isWorkerIdle(handle: WorkerHandle): boolean {
  return (
    handle.pending.size === 0 &&
    handle.pendingTurns.size === 0 &&
    handle.turnQueue.length === 0 &&
    !handle.activeTurnId &&
    !handle.readyRequestId
  );
}

export function toSessionWorkerInfo(handle: WorkerHandle): SessionWorkerInfo {
  return {
    sessionId: handle.sessionId,
    pid: handle.child.pid ?? 0,
    startedAt: handle.startedAt,
    lastHeartbeatAt: handle.lastHeartbeatAt,
    lastActivityAt: handle.lastActivityAt,
    pendingRequests: handle.pending.size + handle.pendingTurns.size + handle.turnQueue.length,
    agentSessionId: handle.requestedAgentSessionId,
    cwd: handle.cwd,
  };
}

export function toRegistryEntries(handles: Iterable<WorkerHandle>): ChildRegistryEntry[] {
  return [...handles]
    .map((handle) => ({
      sessionId: handle.sessionId,
      pid: handle.child.pid ?? 0,
      startedAt: handle.startedAt,
    }))
    .filter((row) => row.pid > 0);
}
