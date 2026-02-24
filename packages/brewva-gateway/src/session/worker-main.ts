import { collectSessionPromptOutput } from "./collect-output.js";
import { createGatewaySession, type GatewaySessionResult } from "./create-session.js";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "./worker-protocol.js";

const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_HEARTBEAT_INTERVAL_MS = 4_000;

let requestedSessionId = "";
let expectedParentPid = 0;
let initialized = false;
let sessionResult: GatewaySessionResult | null = null;
let lastPingAt = Date.now();
let watchdog: ReturnType<typeof setInterval> | null = null;
let heartbeatTicker: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let activeTurnId: string | null = null;
type WorkerLogLevel = Extract<WorkerToParentMessage, { kind: "log" }>["level"];

function send(message: WorkerToParentMessage): void {
  if (typeof process.send !== "function") {
    return;
  }
  process.send(message);
}

function log(level: WorkerLogLevel, message: string, fields?: Record<string, unknown>): void {
  send({
    kind: "log",
    level,
    message,
    fields,
  });
}

async function shutdown(exitCode = 0, reason = "shutdown"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (heartbeatTicker) {
    clearInterval(heartbeatTicker);
    heartbeatTicker = null;
  }

  if (sessionResult) {
    try {
      await sessionResult.session.abort();
    } catch {
      // best effort
    }
    try {
      sessionResult.session.dispose();
    } catch {
      // best effort
    }
    sessionResult = null;
  }

  log("info", "worker exiting", { reason, exitCode, requestedSessionId });
  process.exit(exitCode);
}

function startBridgeWatchdog(): void {
  if (watchdog) return;

  watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastPingAt > BRIDGE_TIMEOUT_MS) {
      void shutdown(1, "bridge_timeout");
      return;
    }

    if (expectedParentPid > 0 && process.ppid !== expectedParentPid) {
      void shutdown(1, "parent_pid_mismatch");
      return;
    }
  }, 1000);
  watchdog.unref?.();

  heartbeatTicker = setInterval(() => {
    send({ kind: "bridge.heartbeat", ts: Date.now() });
  }, BRIDGE_HEARTBEAT_INTERVAL_MS);
  heartbeatTicker.unref?.();
}

async function handleInit(
  message: Extract<ParentToWorkerMessage, { kind: "init" }>,
): Promise<void> {
  if (initialized) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker already initialized",
    });
    return;
  }

  initialized = true;
  requestedSessionId = message.payload.sessionId;
  expectedParentPid = message.payload.parentPid;

  try {
    sessionResult = await createGatewaySession({
      cwd: message.payload.cwd,
      configPath: message.payload.configPath,
      model: message.payload.model,
      agentId: message.payload.agentId,
      enableExtensions: message.payload.enableExtensions,
    });
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    process.title = `brewva-worker:${requestedSessionId}`;
    lastPingAt = Date.now();
    startBridgeWatchdog();

    send({
      kind: "ready",
      requestId: message.requestId,
      payload: {
        requestedSessionId,
        agentSessionId,
      },
    });

    log("info", "worker initialized", {
      requestedSessionId,
      agentSessionId,
      parentPid: expectedParentPid,
    });
  } catch (error) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    await shutdown(1, "init_failed");
  }
}

async function handleSend(
  message: Extract<ParentToWorkerMessage, { kind: "send" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker session not initialized",
    });
    return;
  }

  if (activeTurnId) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: `session is busy with active turn: ${activeTurnId}`,
      errorCode: "session_busy",
    });
    return;
  }

  const candidateTurnId = message.payload.turnId.trim();
  const turnId = candidateTurnId || message.requestId;
  activeTurnId = turnId;
  const agentSessionId = sessionResult.session.sessionManager.getSessionId();

  send({
    kind: "result",
    requestId: message.requestId,
    ok: true,
    payload: {
      sessionId: requestedSessionId,
      agentSessionId,
      turnId,
      accepted: true,
    },
  });

  void runTurn({
    turnId,
    prompt: message.payload.prompt,
    agentSessionId,
  });
}

async function runTurn(input: {
  turnId: string;
  prompt: string;
  agentSessionId: string;
}): Promise<void> {
  if (!sessionResult) {
    activeTurnId = null;
    return;
  }

  send({
    kind: "event",
    event: "session.turn.start",
    payload: {
      sessionId: requestedSessionId,
      agentSessionId: input.agentSessionId,
      turnId: input.turnId,
      ts: Date.now(),
    },
  });

  try {
    const output = await collectSessionPromptOutput(sessionResult.session, input.prompt, {
      onChunk: (chunk) => {
        send({
          kind: "event",
          event: "session.turn.chunk",
          payload: {
            sessionId: requestedSessionId,
            agentSessionId: input.agentSessionId,
            turnId: input.turnId,
            chunk,
            ts: Date.now(),
          },
        });
      },
    });

    send({
      kind: "event",
      event: "session.turn.end",
      payload: {
        sessionId: requestedSessionId,
        agentSessionId: input.agentSessionId,
        turnId: input.turnId,
        assistantText: output.assistantText,
        toolOutputs: output.toolOutputs,
        ts: Date.now(),
      },
    });
  } catch (error) {
    send({
      kind: "event",
      event: "session.turn.error",
      payload: {
        sessionId: requestedSessionId,
        agentSessionId: input.agentSessionId,
        turnId: input.turnId,
        message: error instanceof Error ? error.message : String(error),
        ts: Date.now(),
      },
    });
  } finally {
    activeTurnId = null;
  }
}

async function handleAbort(
  message: Extract<ParentToWorkerMessage, { kind: "abort" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker session not initialized",
    });
    return;
  }

  try {
    await sessionResult.session.abort();
    send({
      kind: "result",
      requestId: message.requestId,
      ok: true,
      payload: {
        sessionId: requestedSessionId,
        aborted: true,
      },
    });
  } catch (error) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleMessage(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const message = raw as {
    kind?: unknown;
    requestId?: unknown;
    payload?: unknown;
  };
  const kind = typeof message.kind === "string" ? message.kind : "";
  if (kind === "bridge.ping") {
    lastPingAt = Date.now();
    return;
  }

  if (kind === "init") {
    await handleInit(raw as Extract<ParentToWorkerMessage, { kind: "init" }>);
    return;
  }

  if (!initialized) {
    const requestId = typeof message.requestId === "string" ? message.requestId : "unknown";
    send({
      kind: "result",
      requestId,
      ok: false,
      error: "worker is not initialized",
    });
    return;
  }

  if (kind === "send") {
    await handleSend(raw as Extract<ParentToWorkerMessage, { kind: "send" }>);
    return;
  }

  if (kind === "abort") {
    await handleAbort(raw as Extract<ParentToWorkerMessage, { kind: "abort" }>);
    return;
  }

  if (kind === "shutdown") {
    const shutdownMessage = raw as Extract<ParentToWorkerMessage, { kind: "shutdown" }>;
    const requestId = shutdownMessage.requestId;
    send({
      kind: "result",
      requestId,
      ok: true,
      payload: {
        sessionId: requestedSessionId,
        stopped: true,
      },
    });
    await shutdown(0, shutdownMessage.payload?.reason ?? "shutdown_requested");
  }
}

process.on("message", (message) => {
  void handleMessage(message);
});

process.on("disconnect", () => {
  void shutdown(0, "parent_disconnected");
});

process.on("SIGTERM", () => {
  void shutdown(0, "sigterm");
});

process.on("SIGINT", () => {
  void shutdown(0, "sigint");
});
