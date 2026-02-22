import type { GatewayToolOutput, SessionStreamChunk } from "./collect-output.js";

export type WorkerResultErrorCode = "session_busy";

export type ParentToWorkerMessage =
  | {
      kind: "init";
      requestId: string;
      payload: {
        sessionId: string;
        cwd?: string;
        configPath?: string;
        model?: string;
        enableExtensions?: boolean;
        parentPid: number;
      };
    }
  | {
      kind: "send";
      requestId: string;
      payload: {
        prompt: string;
        turnId: string;
      };
    }
  | {
      kind: "abort";
      requestId: string;
    }
  | {
      kind: "bridge.ping";
      ts: number;
    }
  | {
      kind: "shutdown";
      requestId: string;
      payload?: {
        reason?: string;
      };
    };

export type WorkerToParentMessage =
  | {
      kind: "ready";
      requestId: string;
      payload: {
        requestedSessionId: string;
        agentSessionId: string;
      };
    }
  | {
      kind: "result";
      requestId: string;
      ok: true;
      payload?: Record<string, unknown>;
    }
  | {
      kind: "result";
      requestId: string;
      ok: false;
      error: string;
      errorCode?: WorkerResultErrorCode;
    }
  | {
      kind: "event";
      event: "session.turn.start";
      payload: {
        sessionId: string;
        agentSessionId: string;
        turnId: string;
        ts: number;
      };
    }
  | {
      kind: "event";
      event: "session.turn.chunk";
      payload: {
        sessionId: string;
        agentSessionId: string;
        turnId: string;
        chunk: SessionStreamChunk;
        ts: number;
      };
    }
  | {
      kind: "event";
      event: "session.turn.error";
      payload: {
        sessionId: string;
        agentSessionId: string;
        turnId: string;
        message: string;
        ts: number;
      };
    }
  | {
      kind: "event";
      event: "session.turn.end";
      payload: {
        sessionId: string;
        agentSessionId: string;
        turnId: string;
        assistantText: string;
        toolOutputs: GatewayToolOutput[];
        ts: number;
      };
    }
  | {
      kind: "bridge.heartbeat";
      ts: number;
    }
  | {
      kind: "log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      fields?: Record<string, unknown>;
    };
