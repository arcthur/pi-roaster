import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayDaemon,
  PROTOCOL_VERSION,
  connectGatewayClient,
  readGatewayToken,
} from "@brewva/brewva-gateway";
import WebSocket, { type RawData } from "ws";

interface PolicyRule {
  id: string;
  intervalMinutes: number;
  prompt: string;
  sessionId?: string;
}

interface RawEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

interface RawResponseFrame {
  type: "res";
  id: string;
  traceId?: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

interface DaemonHarness {
  root: string;
  policyPath: string;
  token: string;
  daemon: GatewayDaemon;
  host: string;
  port: number;
  dispose: () => Promise<void>;
}

function writeHeartbeatPolicy(policyPath: string, rules: PolicyRule[]): void {
  writeFileSync(
    policyPath,
    ["# HEARTBEAT", "", "```heartbeat", JSON.stringify({ rules }), "```", ""].join("\n"),
    "utf8",
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => {
        rejectPromise(new Error(message));
      },
      Math.max(100, timeoutMs),
    );
    timer.unref?.();

    promise
      .then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
  });
}

function rawToText(raw: RawData): string {
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

function parseRawFrame(raw: RawData): unknown {
  try {
    return JSON.parse(rawToText(raw)) as unknown;
  } catch {
    return undefined;
  }
}

async function waitForRawFrame<T>(
  ws: WebSocket,
  predicate: (frame: unknown) => frame is T,
  timeoutMs = 3_000,
): Promise<T> {
  return await withTimeout(
    new Promise<T>((resolveFrame, rejectFrame) => {
      const onMessage = (raw: RawData): void => {
        const frame = parseRawFrame(raw);
        if (!predicate(frame)) {
          return;
        }
        ws.off("message", onMessage);
        ws.off("close", onClose);
        resolveFrame(frame);
      };
      const onClose = (): void => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        rejectFrame(new Error("socket closed before expected frame"));
      };

      ws.on("message", onMessage);
      ws.once("close", onClose);
    }),
    timeoutMs,
    "timed out waiting for websocket frame",
  );
}

async function waitForNoRawFrame<T>(
  ws: WebSocket,
  predicate: (frame: unknown) => frame is T,
  timeoutMs = 700,
): Promise<void> {
  await withTimeout(
    new Promise<void>((resolveNoFrame, rejectNoFrame) => {
      const timer = setTimeout(
        () => {
          ws.off("message", onMessage);
          ws.off("close", onClose);
          resolveNoFrame();
        },
        Math.max(100, timeoutMs),
      );
      timer.unref?.();

      const onMessage = (raw: RawData): void => {
        const frame = parseRawFrame(raw);
        if (!predicate(frame)) {
          return;
        }
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        rejectNoFrame(new Error("received unexpected websocket frame"));
      };
      const onClose = (): void => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        resolveNoFrame();
      };

      ws.on("message", onMessage);
      ws.once("close", onClose);
    }),
    timeoutMs + 200,
    "timed out waiting for no-frame assertion",
  );
}

async function sendRawRequest(
  ws: WebSocket,
  method: string,
  params: unknown,
  timeoutMs = 3_000,
  options: {
    traceId?: string;
  } = {},
): Promise<RawResponseFrame> {
  const id = randomUUID();
  const responsePromise = waitForRawFrame<RawResponseFrame>(
    ws,
    (frame: unknown): frame is RawResponseFrame => {
      if (!frame || typeof frame !== "object") {
        return false;
      }
      const row = frame as Partial<RawResponseFrame>;
      return row.type === "res" && row.id === id;
    },
    timeoutMs,
  );

  await new Promise<void>((resolveSend, rejectSend) => {
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        traceId: options.traceId,
        method,
        params,
      }),
      (error?: Error) => {
        if (error) {
          rejectSend(error);
          return;
        }
        resolveSend();
      },
    );
  });

  return await responsePromise;
}

async function connectRawAuthenticated(input: {
  host: string;
  port: number;
  token: string;
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${input.host}:${input.port}`);
  await withTimeout(
    new Promise<void>((resolveOpen, rejectOpen) => {
      ws.once("open", () => resolveOpen());
      ws.once("error", rejectOpen);
    }),
    3_000,
    "websocket open timeout",
  );

  const challengeFrame = await waitForRawFrame<RawEventFrame>(
    ws,
    (frame: unknown): frame is RawEventFrame => {
      if (!frame || typeof frame !== "object") {
        return false;
      }
      const row = frame as Partial<RawEventFrame>;
      return row.type === "event" && row.event === "connect.challenge";
    },
  );
  const challengeNonce =
    challengeFrame.payload &&
    typeof challengeFrame.payload === "object" &&
    typeof (challengeFrame.payload as { nonce?: unknown }).nonce === "string"
      ? ((challengeFrame.payload as { nonce: string }).nonce ?? "")
      : "";
  if (!challengeNonce) {
    throw new Error("missing challenge nonce");
  }

  const connectResult = await sendRawRequest(ws, "connect", {
    protocol: PROTOCOL_VERSION,
    client: {
      id: "integration-raw",
      version: "0.1.0",
    },
    auth: { token: input.token },
    challengeNonce,
  });
  if (!connectResult.ok) {
    throw new Error(`raw connect failed: ${connectResult.error?.message ?? "unknown"}`);
  }
  return ws;
}

async function closeRawSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await withTimeout(
    new Promise<void>((resolveClose) => {
      ws.once("close", () => resolveClose());
      try {
        ws.close();
      } catch {
        ws.terminate();
        resolveClose();
      }
    }),
    2_000,
    "timed out closing raw websocket",
  ).catch(() => {
    ws.terminate();
  });
}

async function startDaemonHarness(initialRules: PolicyRule[]): Promise<DaemonHarness> {
  const root = mkdtempSync(join(tmpdir(), "brewva-gateway-integration-"));
  const stateDir = join(root, "state");
  const policyPath = join(root, "HEARTBEAT.md");
  const tokenFilePath = join(stateDir, "gateway.token");

  writeHeartbeatPolicy(policyPath, initialRules);
  const port = await allocatePort();

  const daemon = new GatewayDaemon({
    host: "127.0.0.1",
    port,
    stateDir,
    pidFilePath: join(stateDir, "gateway.pid.json"),
    logFilePath: join(stateDir, "gateway.log"),
    tokenFilePath,
    heartbeatPolicyPath: policyPath,
    cwd: root,
    tickIntervalMs: 1_000,
  });
  await daemon.start();
  const runtime = daemon.getRuntimeInfo();
  const token = readGatewayToken(tokenFilePath);
  if (!token) {
    await daemon.stop("missing_token_after_start").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw new Error("gateway token file missing after daemon start");
  }

  return {
    root,
    policyPath,
    token,
    daemon,
    host: runtime.host,
    port: runtime.port,
    dispose: async () => {
      await daemon.stop("test_dispose").catch(() => undefined);
      await daemon.waitForStop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        probe.close(() => {
          rejectPort(new Error("failed to allocate local port"));
        });
        return;
      }
      const resolvedPort = address.port;
      probe.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(resolvedPort);
      });
    });
    probe.unref();
  });
}

function injectWorkerEvent(daemon: GatewayDaemon, event: string, payload: unknown): void {
  const handler = Reflect.get(daemon, "handleWorkerEvent") as (
    eventName: string,
    eventPayload: unknown,
  ) => void;
  handler.call(daemon, event, payload);
}

describe("gateway daemon integration", () => {
  test("enforces auth flow and rejects invalid request params", async () => {
    const harness = await startDaemonHarness([]);
    const ws = new WebSocket(`ws://${harness.host}:${harness.port}`);
    try {
      await withTimeout(
        new Promise<void>((resolveOpen, rejectOpen) => {
          ws.once("open", () => resolveOpen());
          ws.once("error", rejectOpen);
        }),
        3_000,
        "websocket open timeout",
      );

      const challengeFrame = await waitForRawFrame<RawEventFrame>(
        ws,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          return row.type === "event" && row.event === "connect.challenge";
        },
      );
      const challengeNonce =
        challengeFrame.payload &&
        typeof challengeFrame.payload === "object" &&
        typeof (challengeFrame.payload as { nonce?: unknown }).nonce === "string"
          ? ((challengeFrame.payload as { nonce: string }).nonce ?? "")
          : "";
      expect(challengeNonce.length > 0).toBe(true);

      const beforeConnect = await sendRawRequest(ws, "health", {});
      expect(beforeConnect.ok).toBe(false);
      expect(beforeConnect.error?.code).toBe("unauthorized");

      const badNonceConnect = await sendRawRequest(ws, "connect", {
        protocol: PROTOCOL_VERSION,
        client: {
          id: "integration-raw",
          version: "0.1.0",
        },
        auth: { token: harness.token },
        challengeNonce: "wrong-nonce",
      });
      expect(badNonceConnect.ok).toBe(false);
      expect(badNonceConnect.error?.code).toBe("unauthorized");

      const connectOk = await sendRawRequest(ws, "connect", {
        protocol: PROTOCOL_VERSION,
        client: {
          id: "integration-raw",
          version: "0.1.0",
        },
        auth: { token: harness.token },
        challengeNonce,
      });
      expect(connectOk.ok).toBe(true);

      const invalidParams = await sendRawRequest(ws, "sessions.close", {});
      expect(invalidParams.ok).toBe(false);
      expect(invalidParams.error?.code).toBe("invalid_request");
    } finally {
      await closeRawSocket(ws);
      await harness.dispose();
    }
  });

  test("returns reload metadata after policy changes and keeps deep status consistent", async () => {
    const harness = await startDaemonHarness([
      { id: "rule-a", intervalMinutes: 5, prompt: "A" },
      { id: "rule-b", intervalMinutes: 10, prompt: "B", sessionId: "ops" },
    ]);

    let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    try {
      client = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: harness.token,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });

      writeHeartbeatPolicy(harness.policyPath, [
        { id: "rule-b", intervalMinutes: 10, prompt: "B2", sessionId: "ops" },
        { id: "rule-c", intervalMinutes: 15, prompt: "C" },
      ]);

      const reloaded = (await client.request("heartbeat.reload", {})) as {
        rules?: number;
        removedRules?: number;
        removedRuleIds?: string[];
        closedSessions?: number;
        closedSessionIds?: string[];
      };
      expect(reloaded.rules).toBe(2);
      expect(reloaded.removedRules).toBe(1);
      expect(reloaded.removedRuleIds).toEqual(["rule-a"]);
      expect(reloaded.closedSessions).toBe(0);
      expect(reloaded.closedSessionIds).toEqual([]);

      const deep = (await client.request("status.deep", {})) as {
        heartbeat?: {
          rules?: Array<{ id?: string }>;
        };
      };
      const ids = (deep.heartbeat?.rules ?? []).map((rule) => rule.id);
      expect(ids).toEqual(["rule-b", "rule-c"]);
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      await harness.dispose();
    }
  });

  test("echoes request traceId in response frames", async () => {
    const harness = await startDaemonHarness([]);
    let ws: WebSocket | null = null;
    try {
      ws = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const traceId = `trace-${randomUUID()}`;
      const response = await sendRawRequest(ws, "health", {}, 3_000, { traceId });
      expect(response.ok).toBe(true);
      expect(response.traceId).toBe(traceId);
    } finally {
      if (ws) {
        await closeRawSocket(ws);
      }
      await harness.dispose();
    }
  });

  test("rotates token and immediately rejects old token", async () => {
    const harness = await startDaemonHarness([]);
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    let freshClient: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    try {
      client = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: harness.token,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });

      const rotated = (await client.request("gateway.rotate-token", {})) as {
        rotated?: boolean;
        revokedConnections?: number;
      };
      expect(rotated.rotated).toBe(true);
      expect(typeof rotated.revokedConnections).toBe("number");
      if (typeof rotated.revokedConnections === "number") {
        expect(rotated.revokedConnections).toBeGreaterThanOrEqual(1);
      }

      await client.close().catch(() => undefined);
      client = null;

      let staleTokenError: unknown;
      try {
        await connectGatewayClient({
          host: harness.host,
          port: harness.port,
          token: harness.token,
          connectTimeoutMs: 1_500,
          requestTimeoutMs: 1_500,
        });
      } catch (error) {
        staleTokenError = error;
      }
      expect(staleTokenError).toBeInstanceOf(Error);
      if (!(staleTokenError instanceof Error)) {
        throw new Error("expected stale token connection to fail");
      }
      expect(staleTokenError.message).toBe("[unauthorized] invalid token");

      const newToken = readGatewayToken(join(harness.root, "state", "gateway.token"));
      expect(typeof newToken).toBe("string");
      expect(newToken && newToken.length > 0).toBe(true);
      expect(newToken).not.toBe(harness.token);

      freshClient = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: newToken!,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });
      const health = (await freshClient.request("health", {})) as { ok?: boolean };
      expect(health.ok).toBe(true);
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      if (freshClient) {
        await freshClient.close().catch(() => undefined);
      }
      await harness.dispose();
    }
  });

  test("rejects repeated connect request after authentication", async () => {
    const harness = await startDaemonHarness([]);
    let ws: WebSocket | null = null;
    try {
      ws = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const response = await sendRawRequest(
        ws,
        "connect",
        {
          protocol: PROTOCOL_VERSION,
          client: {
            id: "integration-raw",
            version: "0.1.0",
          },
        },
        3_000,
        { traceId: "trace-reconnect" },
      );
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("bad_state");
      expect(response.traceId).toBe("trace-reconnect");
    } finally {
      if (ws) {
        await closeRawSocket(ws);
      }
      await harness.dispose();
    }
  });

  test("handles concurrent requests on a single websocket client", async () => {
    const harness = await startDaemonHarness([{ id: "rule-a", intervalMinutes: 5, prompt: "A" }]);

    let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    try {
      client = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: harness.token,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });

      const operations = Array.from({ length: 24 }, (_, index) => {
        const slot = index % 4;
        if (slot === 0) {
          return client!.request("health", {});
        }
        if (slot === 1) {
          return client!.request("status.deep", {});
        }
        if (slot === 2) {
          return client!.request("sessions.close", { sessionId: `ghost-${index}` });
        }
        return client!.request("heartbeat.reload", {});
      });

      const results = await Promise.all(operations);
      expect(results.length).toBe(24);

      const closePayloads = results.filter(
        (value) =>
          value &&
          typeof value === "object" &&
          typeof (value as { sessionId?: unknown }).sessionId === "string" &&
          Object.hasOwn(value, "closed"),
      ) as Array<{ sessionId: string; closed: boolean }>;
      expect(closePayloads.length).toBe(6);
      for (const payload of closePayloads) {
        expect(payload.closed).toBe(false);
        expect(payload.sessionId.startsWith("ghost-")).toBe(true);
      }

      const healthPayloads = results.filter(
        (value) => value && typeof value === "object" && (value as { ok?: unknown }).ok === true,
      ) as Array<{ ok: boolean }>;
      expect(healthPayloads.length >= 6).toBe(true);
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      await harness.dispose();
    }
  });

  test("stops cleanly when remote gateway.stop is requested", async () => {
    const harness = await startDaemonHarness([]);

    let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    try {
      client = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: harness.token,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });

      const stopPayload = (await client.request("gateway.stop", {
        reason: "integration_shutdown",
      })) as { stopping?: boolean; reason?: string };
      expect(stopPayload.stopping).toBe(true);
      expect(stopPayload.reason).toBe("integration_shutdown");

      await withTimeout(harness.daemon.waitForStop(), 4_000, "daemon did not stop in time");
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      await harness.dispose();
    }
  });

  test("routes session-scoped worker events only to subscribed connections", async () => {
    const harness = await startDaemonHarness([]);
    let wsA: WebSocket | null = null;
    let wsB: WebSocket | null = null;
    try {
      wsA = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsB = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const subscribeA = await sendRawRequest(wsA, "sessions.subscribe", {
        sessionId: "session-A",
      });
      const subscribeB = await sendRawRequest(wsB, "sessions.subscribe", {
        sessionId: "session-B",
      });
      expect(subscribeA.ok).toBe(true);
      expect(subscribeB.ok).toBe(true);

      const subscribedEventPromise = waitForRawFrame<RawEventFrame>(
        wsA,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.start") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-A";
        },
        2_000,
      );

      injectWorkerEvent(harness.daemon, "session.turn.start", {
        sessionId: "session-A",
        agentSessionId: "agent-A",
        turnId: "turn-A",
        ts: Date.now(),
      });

      const scopedEvent = await subscribedEventPromise;
      expect(scopedEvent.event).toBe("session.turn.start");

      await waitForNoRawFrame(
        wsB,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.start") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-A";
        },
        800,
      );
    } finally {
      if (wsA) {
        await closeRawSocket(wsA);
      }
      if (wsB) {
        await closeRawSocket(wsB);
      }
      await harness.dispose();
    }
  });

  test("unsubscribe and socket close cleanup scoped subscriptions", async () => {
    const harness = await startDaemonHarness([]);
    let ws: WebSocket | null = null;
    try {
      ws = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const subscribed = await sendRawRequest(ws, "sessions.subscribe", {
        sessionId: "session-cleanup",
      });
      expect(subscribed.ok).toBe(true);

      const unsubscribed = await sendRawRequest(ws, "sessions.unsubscribe", {
        sessionId: "session-cleanup",
      });
      expect(unsubscribed.ok).toBe(true);

      injectWorkerEvent(harness.daemon, "session.turn.end", {
        sessionId: "session-cleanup",
        agentSessionId: "agent-cleanup",
        turnId: "turn-cleanup",
        assistantText: "done",
        toolOutputs: [],
        ts: Date.now(),
      });

      await waitForNoRawFrame(
        ws,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.end") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-cleanup";
        },
        800,
      );

      const resubscribed = await sendRawRequest(ws, "sessions.subscribe", {
        sessionId: "session-cleanup",
      });
      expect(resubscribed.ok).toBe(true);

      await closeRawSocket(ws);
      ws = null;

      const subscriptions = Reflect.get(harness.daemon, "sessionSubscribers") as Map<
        string,
        Set<string>
      >;
      await withTimeout(
        new Promise<void>((resolveCleanup, rejectCleanup) => {
          const startedAt = Date.now();
          const poll = (): void => {
            if (!subscriptions.has("session-cleanup")) {
              resolveCleanup();
              return;
            }
            if (Date.now() - startedAt > 1_500) {
              rejectCleanup(new Error("session subscription cleanup timeout"));
              return;
            }
            setTimeout(poll, 25).unref?.();
          };
          poll();
        }),
        2_000,
        "subscription cleanup wait timeout",
      );
      expect(subscriptions.has("session-cleanup")).toBe(false);
    } finally {
      if (ws) {
        await closeRawSocket(ws);
      }
      await harness.dispose();
    }
  });

  test("scoped events keep identical seq for all subscribers of same session", async () => {
    const harness = await startDaemonHarness([]);
    let wsA: WebSocket | null = null;
    let wsB: WebSocket | null = null;
    try {
      wsA = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsB = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const [subscribeA, subscribeB] = await Promise.all([
        sendRawRequest(wsA, "sessions.subscribe", { sessionId: "session-shared" }),
        sendRawRequest(wsB, "sessions.subscribe", { sessionId: "session-shared" }),
      ]);
      expect(subscribeA.ok).toBe(true);
      expect(subscribeB.ok).toBe(true);

      const eventAPromise = waitForRawFrame<RawEventFrame>(
        wsA,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.chunk") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-shared";
        },
        2_000,
      );
      const eventBPromise = waitForRawFrame<RawEventFrame>(
        wsB,
        (frame: unknown): frame is RawEventFrame => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const row = frame as Partial<RawEventFrame>;
          if (row.type !== "event" || row.event !== "session.turn.chunk") {
            return false;
          }
          const payload = row.payload as { sessionId?: unknown } | undefined;
          return payload?.sessionId === "session-shared";
        },
        2_000,
      );

      injectWorkerEvent(harness.daemon, "session.turn.chunk", {
        sessionId: "session-shared",
        agentSessionId: "agent-shared",
        turnId: "turn-shared",
        chunk: {
          kind: "assistant_text_delta",
          delta: "hello",
        },
        ts: Date.now(),
      });

      const [resolvedA, resolvedB] = await Promise.all([eventAPromise, eventBPromise]);
      expect(typeof resolvedA.seq).toBe("number");
      expect(typeof resolvedB.seq).toBe("number");
      expect(resolvedA.seq).toBe(resolvedB.seq);
    } finally {
      if (wsA) {
        await closeRawSocket(wsA);
      }
      if (wsB) {
        await closeRawSocket(wsB);
      }
      await harness.dispose();
    }
  });

  test("broadcast events keep the same seq across authenticated connections", async () => {
    const harness = await startDaemonHarness([]);
    let wsA: WebSocket | null = null;
    let wsB: WebSocket | null = null;
    try {
      wsA = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsB = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const [tickA, tickB] = await Promise.all([
        waitForRawFrame<{ type: "event"; event: "tick"; seq?: number }>(
          wsA,
          (frame: unknown): frame is { type: "event"; event: "tick"; seq?: number } => {
            if (!frame || typeof frame !== "object") {
              return false;
            }
            const row = frame as { type?: unknown; event?: unknown };
            return row.type === "event" && row.event === "tick";
          },
          4_000,
        ),
        waitForRawFrame<{ type: "event"; event: "tick"; seq?: number }>(
          wsB,
          (frame: unknown): frame is { type: "event"; event: "tick"; seq?: number } => {
            if (!frame || typeof frame !== "object") {
              return false;
            }
            const row = frame as { type?: unknown; event?: unknown };
            return row.type === "event" && row.event === "tick";
          },
          4_000,
        ),
      ]);

      expect(typeof tickA.seq).toBe("number");
      expect(typeof tickB.seq).toBe("number");
      expect(tickA.seq).toBe(tickB.seq);
    } finally {
      if (wsA) {
        await closeRawSocket(wsA);
      }
      if (wsB) {
        await closeRawSocket(wsB);
      }
      await harness.dispose();
    }
  });
});
