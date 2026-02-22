import type { GatewayToolOutput } from "../session/collect-output.js";

export interface OpenSessionInput {
  sessionId: string;
  cwd?: string;
  configPath?: string;
  model?: string;
  enableExtensions?: boolean;
}

export interface OpenSessionResult {
  sessionId: string;
  created: boolean;
  workerPid: number;
  agentSessionId?: string;
}

export interface SessionWorkerInfo {
  sessionId: string;
  pid: number;
  startedAt: number;
  lastHeartbeatAt: number;
  lastActivityAt: number;
  pendingRequests: number;
  agentSessionId?: string;
  cwd?: string;
}

export interface SendPromptOptions {
  turnId?: string;
  waitForCompletion?: boolean;
}

export interface SendPromptOutput {
  assistantText: string;
  toolOutputs: GatewayToolOutput[];
}

export interface SendPromptResult {
  sessionId: string;
  agentSessionId?: string;
  turnId: string;
  accepted: true;
  output?: SendPromptOutput;
}

export interface SessionBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  openSession(input: OpenSessionInput): Promise<OpenSessionResult>;
  sendPrompt(
    sessionId: string,
    prompt: string,
    options?: SendPromptOptions,
  ): Promise<SendPromptResult>;
  abortSession(sessionId: string): Promise<boolean>;
  stopSession(sessionId: string, reason?: string, timeoutMs?: number): Promise<boolean>;
  listWorkers(): SessionWorkerInfo[];
}

export type SessionBackendCapacityCode = "worker_limit" | "open_queue_full";
export type SessionBackendStateCode =
  | "session_not_found"
  | "session_busy"
  | "duplicate_active_turn_id";

export class SessionBackendCapacityError extends Error {
  readonly name = "SessionBackendCapacityError";

  constructor(
    public readonly code: SessionBackendCapacityCode,
    message: string,
    public readonly details: {
      maxWorkers: number;
      currentWorkers: number;
      queueDepth: number;
      maxQueueDepth: number;
    },
  ) {
    super(message);
  }
}

export class SessionBackendStateError extends Error {
  readonly name = "SessionBackendStateError";

  constructor(
    public readonly code: SessionBackendStateCode,
    message: string,
  ) {
    super(message);
  }
}

export function isSessionBackendCapacityError(
  error: unknown,
): error is SessionBackendCapacityError {
  return error instanceof SessionBackendCapacityError;
}

export function isSessionBackendStateError(error: unknown): error is SessionBackendStateError {
  return error instanceof SessionBackendStateError;
}
