import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import {
  connectGatewayClient,
  queryGatewayStatus,
  readGatewayToken,
  resolveGatewayPaths,
} from "@brewva/brewva-gateway";

export type CliBackendKind = "auto" | "embedded" | "gateway";

export type GatewayPrintFailureStage = "pre-ack" | "post-ack";

export type GatewayPrintResult =
  | {
      ok: true;
      assistantText: string;
      requestedSessionId: string;
      agentSessionId?: string;
    }
  | {
      ok: false;
      stage: GatewayPrintFailureStage;
      error: string;
    };

export interface TryGatewayPrintInput {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  enableExtensions: boolean;
  prompt: string;
  verbose: boolean;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function resolveBackendWorkingCwd(cwd?: string): string {
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    return resolve(cwd);
  }
  return process.cwd();
}

export function writeGatewayAssistantText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

export function shouldFallbackAfterGatewayFailure(
  backend: CliBackendKind,
  stage: GatewayPrintFailureStage,
): boolean {
  return backend === "auto" && stage === "pre-ack";
}

export function resolveGatewayFailureStage(input: {
  sendRequested: boolean;
  ackReceived: boolean;
}): GatewayPrintFailureStage {
  return input.sendRequested || input.ackReceived ? "post-ack" : "pre-ack";
}

export async function tryGatewayPrint(input: TryGatewayPrintInput): Promise<GatewayPrintResult> {
  const env = process.env;
  const sessionCwd = resolveBackendWorkingCwd(input.cwd);
  const paths = resolveGatewayPaths({
    stateDir:
      typeof env.BREWVA_GATEWAY_STATE_DIR === "string" ? env.BREWVA_GATEWAY_STATE_DIR : undefined,
    pidFilePath:
      typeof env.BREWVA_GATEWAY_PID_FILE === "string" ? env.BREWVA_GATEWAY_PID_FILE : undefined,
    tokenFilePath:
      typeof env.BREWVA_GATEWAY_TOKEN_FILE === "string" ? env.BREWVA_GATEWAY_TOKEN_FILE : undefined,
  });
  const hostOverride =
    typeof env.BREWVA_GATEWAY_HOST === "string" && env.BREWVA_GATEWAY_HOST.trim().length > 0
      ? env.BREWVA_GATEWAY_HOST.trim()
      : undefined;
  const rawPortOverride =
    typeof env.BREWVA_GATEWAY_PORT === "string" ? Number(env.BREWVA_GATEWAY_PORT) : NaN;
  const portOverride =
    Number.isInteger(rawPortOverride) && rawPortOverride > 0 ? rawPortOverride : undefined;
  // queryGatewayStatus returns immediately when pid is missing or stale.
  // timeoutMs mainly applies when a gateway process is alive but probe hangs.
  const status = await queryGatewayStatus({
    paths,
    deep: false,
    timeoutMs: 600,
    hostOverride,
    portOverride,
  });
  if (!status.running) {
    return {
      ok: false,
      stage: "pre-ack",
      error: "gateway daemon is not running",
    };
  }
  if (!status.reachable) {
    return {
      ok: false,
      stage: "pre-ack",
      error: status.error ?? "gateway daemon is not reachable",
    };
  }
  const host = typeof status.host === "string" && status.host.trim() ? status.host : undefined;
  const port = typeof status.port === "number" && Number.isInteger(status.port) ? status.port : 0;
  if (!host || port <= 0) {
    return {
      ok: false,
      stage: "pre-ack",
      error: "gateway status did not return a valid host/port",
    };
  }
  const token = readGatewayToken(paths.tokenFilePath);
  if (!token) {
    return {
      ok: false,
      stage: "pre-ack",
      error: `gateway token missing: ${paths.tokenFilePath}`,
    };
  }

  let ackReceived = false;
  let sendRequested = false;
  let sessionOpened = false;
  const sessionId = randomUUID();
  const requestedTurnId = randomUUID();
  let expectedTurnId: string = requestedTurnId;
  const requestTimeoutMs = 5 * 60_000;

  let completionSettled = false;
  let resolveCompletionRef: ((text: string) => void) | undefined;
  let rejectCompletionRef: ((error: unknown) => void) | undefined;
  const completion = new Promise<string>((resolveCompletion, rejectCompletion) => {
    const timer = setTimeout(() => {
      if (completionSettled) return;
      completionSettled = true;
      rejectCompletion(new Error("gateway turn timed out"));
    }, requestTimeoutMs);
    timer.unref?.();

    resolveCompletionRef = (text: string): void => {
      if (completionSettled) return;
      completionSettled = true;
      clearTimeout(timer);
      resolveCompletion(text);
    };
    rejectCompletionRef = (error: unknown): void => {
      if (completionSettled) return;
      completionSettled = true;
      clearTimeout(timer);
      rejectCompletion(error instanceof Error ? error : new Error(toErrorMessage(error)));
    };
  });

  const resolveCompletion = (text: string): void => {
    resolveCompletionRef?.(text);
  };
  const rejectCompletion = (error: unknown): void => {
    rejectCompletionRef?.(error);
  };

  let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
  let disposeListener: (() => void) | undefined;
  try {
    client = await connectGatewayClient({
      host,
      port,
      token,
      connectTimeoutMs: 1_000,
      requestTimeoutMs,
      clientMode: "cli-print",
    });

    await client.request("sessions.open", {
      sessionId,
      cwd: sessionCwd,
      configPath: input.configPath,
      model: input.model,
      agentId: input.agentId,
      enableExtensions: input.enableExtensions,
    });
    sessionOpened = true;

    disposeListener = client.onEvent((event) => {
      if (event.event !== "session.turn.end" && event.event !== "session.turn.error") {
        return;
      }
      const payload = asRecord(event.payload);
      if (!payload) return;
      if (payload["sessionId"] !== sessionId) return;
      const eventTurnId = typeof payload["turnId"] === "string" ? payload["turnId"] : undefined;
      if (eventTurnId && eventTurnId !== expectedTurnId) return;

      if (event.event === "session.turn.end") {
        const assistantText =
          typeof payload["assistantText"] === "string" ? payload["assistantText"] : "";
        resolveCompletion(assistantText);
        return;
      }
      const message =
        typeof payload["message"] === "string" && payload["message"].trim().length > 0
          ? payload["message"]
          : "gateway turn failed";
      rejectCompletion(new Error(message));
    });

    await client.request("sessions.subscribe", { sessionId });
    sendRequested = true;
    const sendPayload = asRecord(
      await client.request("sessions.send", {
        sessionId,
        prompt: input.prompt,
        turnId: requestedTurnId,
      }),
    );
    if (sendPayload?.["accepted"] !== true) {
      throw new Error("gateway did not accept the turn");
    }
    const acknowledgedTurnId =
      typeof sendPayload["turnId"] === "string" ? sendPayload["turnId"] : requestedTurnId;
    expectedTurnId = acknowledgedTurnId;
    ackReceived = true;

    const assistantText = await completion;
    return {
      ok: true,
      assistantText,
      requestedSessionId: sessionId,
      agentSessionId:
        typeof sendPayload["agentSessionId"] === "string" && sendPayload["agentSessionId"].trim()
          ? sendPayload["agentSessionId"]
          : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      stage: resolveGatewayFailureStage({
        sendRequested,
        ackReceived,
      }),
      error: toErrorMessage(error),
    };
  } finally {
    disposeListener?.();
    if (client && sessionOpened) {
      try {
        await client.request("sessions.close", { sessionId });
      } catch (error) {
        if (input.verbose) {
          console.error(
            `[backend] gateway close failed for session ${sessionId} (${toErrorMessage(error)})`,
          );
        }
      }
    }
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}
