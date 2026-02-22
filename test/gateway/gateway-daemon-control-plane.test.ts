import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayDaemon,
  SessionBackendCapacityError,
  SessionBackendStateError,
} from "@brewva/brewva-gateway";

interface PolicyRule {
  id: string;
  intervalMinutes: number;
  prompt: string;
  sessionId?: string;
}

interface ReloadPayload {
  sourcePath: string;
  loadedAt: number;
  rules: number;
  removedRules: number;
  closedSessions: number;
  removedRuleIds: string[];
  closedSessionIds: string[];
}

interface SessionsClosePayload {
  sessionId: string;
  closed: boolean;
}

interface SupervisorTestHandle {
  sessionId: string;
  child: { pid: number };
  startedAt: number;
  lastActivityAt: number;
  pending: Map<string, unknown>;
  pendingTurns: Map<string, unknown>;
  readyRequestId?: string;
  lastHeartbeatAt: number;
}

interface SupervisorForTest {
  workers: Map<string, SupervisorTestHandle>;
  stopSession: (sessionId: string, reason?: string, timeoutMs?: number) => Promise<boolean>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function writeHeartbeatPolicy(policyPath: string, rules: PolicyRule[]): void {
  writeFileSync(
    policyPath,
    ["# HEARTBEAT", "", "```heartbeat", JSON.stringify({ rules }), "```", ""].join("\n"),
    "utf8",
  );
}

function createDaemonHarness(
  initialRules: PolicyRule[],
  options: {
    sessionIdleTtlMs?: number;
    sessionIdleSweepIntervalMs?: number;
  } = {},
): {
  root: string;
  policyPath: string;
  daemon: GatewayDaemon;
  dispose: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "brewva-gateway-daemon-"));
  const stateDir = join(root, "state");
  const policyPath = join(root, "HEARTBEAT.md");
  writeHeartbeatPolicy(policyPath, initialRules);

  const daemon = new GatewayDaemon({
    host: "127.0.0.1",
    port: 0,
    stateDir,
    pidFilePath: join(stateDir, "gateway.pid.json"),
    logFilePath: join(stateDir, "gateway.log"),
    tokenFilePath: join(stateDir, "gateway.token"),
    heartbeatPolicyPath: policyPath,
    cwd: root,
    sessionIdleTtlMs: options.sessionIdleTtlMs,
    sessionIdleSweepIntervalMs: options.sessionIdleSweepIntervalMs,
  });

  return {
    root,
    policyPath,
    daemon,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function getHandleMethod(
  daemon: GatewayDaemon,
): (method: string, params: unknown, state?: unknown) => Promise<unknown> {
  const handleMethod = Reflect.get(daemon, "handleMethod") as (
    method: string,
    params: unknown,
    state: unknown,
  ) => Promise<unknown>;
  return async (method: string, params: unknown, state: unknown = {}) => {
    return await handleMethod.call(daemon, method, params, state);
  };
}

function getSupervisorForTest(daemon: GatewayDaemon): SupervisorForTest {
  return Reflect.get(daemon, "supervisor") as SupervisorForTest;
}

function createConnectionState(connId = "conn-test"): {
  connId: string;
  subscribedSessions: Set<string>;
  phase: "authenticated";
} {
  return {
    connId,
    subscribedSessions: new Set<string>(),
    phase: "authenticated",
  };
}

function createSupervisorWorker(input: {
  sessionId: string;
  now: number;
  lastActivityOffsetMs: number;
  pendingCount?: number;
  readyRequestId?: string;
}): SupervisorTestHandle {
  const pending = new Map<string, unknown>();
  const pendingCount = input.pendingCount ?? 0;
  for (let index = 0; index < pendingCount; index += 1) {
    pending.set(`pending-${index}`, {});
  }

  return {
    sessionId: input.sessionId,
    child: { pid: 1000 + Math.floor(Math.random() * 1000) },
    startedAt: input.now - 60_000,
    lastActivityAt: input.now - input.lastActivityOffsetMs,
    pending,
    pendingTurns: new Map<string, unknown>(),
    readyRequestId: input.readyRequestId,
    lastHeartbeatAt: input.now,
  };
}

describe("gateway daemon control-plane methods", () => {
  test("sessions.close forwards remote_close reason and supports false return", async () => {
    const harness = createDaemonHarness([]);
    try {
      const supervisor = Reflect.get(harness.daemon, "supervisor") as {
        stopSession: (sessionId: string, reason?: string, timeoutMs?: number) => Promise<boolean>;
      };
      const calls: Array<{ sessionId: string; reason?: string; timeoutMs?: number }> = [];
      supervisor.stopSession = async (sessionId, reason, timeoutMs) => {
        calls.push({ sessionId, reason, timeoutMs });
        return false;
      };

      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("sessions.close", {
        sessionId: "session-42",
      })) as SessionsClosePayload;

      expect(payload).toEqual({
        sessionId: "session-42",
        closed: false,
      });
      expect(calls).toEqual([
        {
          sessionId: "session-42",
          reason: "remote_close",
          timeoutMs: undefined,
        },
      ]);
    } finally {
      harness.dispose();
    }
  });

  test("maps backend capacity errors to gateway bad_state with retry hint", async () => {
    const harness = createDaemonHarness([]);
    try {
      const supervisor = Reflect.get(harness.daemon, "supervisor") as {
        openSession: (input: {
          sessionId: string;
          cwd?: string;
          configPath?: string;
          model?: string;
          enableExtensions?: boolean;
        }) => Promise<unknown>;
      };
      supervisor.openSession = async () => {
        throw new SessionBackendCapacityError("worker_limit", "session worker limit reached: 1", {
          maxWorkers: 1,
          currentWorkers: 1,
          queueDepth: 0,
          maxQueueDepth: 64,
        });
      };

      const handleMethod = getHandleMethod(harness.daemon);
      let openError: unknown;
      try {
        await handleMethod("sessions.open", {
          sessionId: "s-overflow",
        });
      } catch (error) {
        openError = error;
      }
      expect(openError).toMatchObject({
        code: "bad_state",
        retryable: true,
      });
    } finally {
      harness.dispose();
    }
  });

  test("sessions.send streams by default and auto-subscribes caller session scope", async () => {
    const harness = createDaemonHarness([]);
    try {
      const supervisor = Reflect.get(harness.daemon, "supervisor") as {
        sendPrompt: (
          sessionId: string,
          prompt: string,
          options?: { turnId?: string; waitForCompletion?: boolean },
        ) => Promise<{
          sessionId: string;
          agentSessionId?: string;
          turnId: string;
          accepted: true;
        }>;
      };
      const calls: Array<{ sessionId: string; waitForCompletion?: boolean }> = [];
      supervisor.sendPrompt = async (sessionId, _prompt, options) => {
        calls.push({
          sessionId,
          waitForCompletion: options?.waitForCompletion,
        });
        return {
          sessionId,
          agentSessionId: "agent-stream",
          turnId: "turn-stream",
          accepted: true,
        };
      };

      const handleMethod = getHandleMethod(harness.daemon);
      const state = createConnectionState("conn-send-stream");
      const payload = (await handleMethod(
        "sessions.send",
        {
          sessionId: "session-stream",
          prompt: "hello",
        },
        state,
      )) as {
        sessionId: string;
        agentSessionId?: string;
        turnId: string;
        accepted: boolean;
      };

      expect(calls).toEqual([
        {
          sessionId: "session-stream",
          waitForCompletion: false,
        },
      ]);
      expect(payload).toEqual({
        sessionId: "session-stream",
        agentSessionId: "agent-stream",
        turnId: "turn-stream",
        accepted: true,
      });
      expect(state.subscribedSessions.has("session-stream")).toBe(true);

      const subscribers = Reflect.get(harness.daemon, "sessionSubscribers") as Map<
        string,
        Set<string>
      >;
      expect(subscribers.get("session-stream")?.has("conn-send-stream")).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("maps backend session state errors to gateway bad_state", async () => {
    const harness = createDaemonHarness([]);
    try {
      const supervisor = Reflect.get(harness.daemon, "supervisor") as {
        sendPrompt: (
          sessionId: string,
          prompt: string,
          options?: { turnId?: string; waitForCompletion?: boolean },
        ) => Promise<unknown>;
      };
      supervisor.sendPrompt = async () => {
        throw new SessionBackendStateError(
          "session_busy",
          "session is busy with active turn: turn-123",
        );
      };

      const handleMethod = getHandleMethod(harness.daemon);
      let sendError: unknown;
      try {
        await handleMethod(
          "sessions.send",
          {
            sessionId: "session-busy",
            prompt: "hello",
          },
          createConnectionState("conn-send-busy"),
        );
      } catch (error) {
        sendError = error;
      }
      expect(sendError).toMatchObject({
        code: "bad_state",
        retryable: false,
        details: {
          kind: "session_busy",
        },
      });
    } finally {
      harness.dispose();
    }
  });

  test("gateway.rotate-token revokes authenticated connections using previous token", async () => {
    const harness = createDaemonHarness([]);
    try {
      const daemon = harness.daemon;
      const originalToken = Reflect.get(daemon, "authToken") as string;

      const connections = Reflect.get(daemon, "connections") as Map<unknown, unknown>;
      const connectionsById = Reflect.get(daemon, "connectionsById") as Map<string, unknown>;
      const sessionSubscribers = Reflect.get(daemon, "sessionSubscribers") as Map<
        string,
        Set<string>
      >;

      const closeCalls: Array<{ connId: string; code: number; reason: string }> = [];
      function makeSocket(connId: string): {
        readyState: number;
        OPEN: number;
        CONNECTING: number;
        close: (code: number, reason: string) => void;
        terminate: () => void;
      } {
        return {
          readyState: 1,
          OPEN: 1,
          CONNECTING: 0,
          close: (code, reason) => {
            closeCalls.push({ connId, code, reason });
          },
          terminate: () => undefined,
        };
      }

      const rotatorSocket = makeSocket("conn-rotator");
      const peerSocket = makeSocket("conn-peer");

      const rotatorState = {
        connId: "conn-rotator",
        socket: rotatorSocket,
        challengeNonce: "nonce-rotator",
        phase: "authenticated" as "connected" | "authenticating" | "authenticated" | "closing",
        authenticatedToken: originalToken,
        subscribedSessions: new Set<string>(["session-rotator"]),
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      const peerState = {
        connId: "conn-peer",
        socket: peerSocket,
        challengeNonce: "nonce-peer",
        phase: "authenticated" as "connected" | "authenticating" | "authenticated" | "closing",
        authenticatedToken: originalToken,
        subscribedSessions: new Set<string>(["session-peer"]),
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      };

      connections.set(rotatorSocket, rotatorState);
      connections.set(peerSocket, peerState);
      connectionsById.set(rotatorState.connId, rotatorState);
      connectionsById.set(peerState.connId, peerState);
      sessionSubscribers.set("session-rotator", new Set([rotatorState.connId]));
      sessionSubscribers.set("session-peer", new Set([peerState.connId]));

      const handleMethod = getHandleMethod(daemon);
      const payload = (await handleMethod("gateway.rotate-token", {}, rotatorState)) as {
        rotated: boolean;
        revokedConnections: number;
      };

      expect(payload.rotated).toBe(true);
      expect(payload.revokedConnections).toBe(2);
      expect(rotatorState.phase).toBe("closing");
      expect(peerState.phase).toBe("closing");
      expect(rotatorState.subscribedSessions.size).toBe(0);
      expect(peerState.subscribedSessions.size).toBe(0);
      expect(sessionSubscribers.has("session-rotator")).toBe(false);
      expect(sessionSubscribers.has("session-peer")).toBe(false);

      await sleep(30);

      expect(closeCalls).toEqual([
        {
          connId: "conn-rotator",
          code: 1008,
          reason: "auth token rotated",
        },
        {
          connId: "conn-peer",
          code: 1008,
          reason: "auth token rotated",
        },
      ]);
      const nextToken = Reflect.get(daemon, "authToken") as string;
      expect(nextToken).not.toBe(originalToken);
    } finally {
      harness.dispose();
    }
  });

  test("heartbeat.reload cleans only default orphaned sessions and keeps shared or explicit sessions", async () => {
    const harness = createDaemonHarness([
      {
        id: "default-removed",
        intervalMinutes: 5,
        prompt: "old-a",
      },
      {
        id: "explicit-removed",
        intervalMinutes: 5,
        prompt: "old-b",
        sessionId: "shared-session",
      },
      {
        id: "shared-keeper",
        intervalMinutes: 5,
        prompt: "old-c",
        sessionId: "shared-session",
      },
      {
        id: "session-changed",
        intervalMinutes: 5,
        prompt: "old-d",
      },
      {
        id: "stop-false",
        intervalMinutes: 5,
        prompt: "old-e",
      },
    ]);

    try {
      writeHeartbeatPolicy(harness.policyPath, [
        {
          id: "shared-keeper",
          intervalMinutes: 5,
          prompt: "new-c",
          sessionId: "shared-session",
        },
        {
          id: "session-changed",
          intervalMinutes: 5,
          prompt: "new-d",
          sessionId: "explicit-new-session",
        },
      ]);

      const supervisor = Reflect.get(harness.daemon, "supervisor") as {
        stopSession: (sessionId: string, reason?: string, timeoutMs?: number) => Promise<boolean>;
      };
      const stopCalls: Array<{ sessionId: string; reason?: string; timeoutMs?: number }> = [];
      supervisor.stopSession = async (sessionId, reason, timeoutMs) => {
        stopCalls.push({ sessionId, reason, timeoutMs });
        return sessionId !== "heartbeat:stop-false";
      };

      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("heartbeat.reload", {})) as ReloadPayload;

      expect(payload.rules).toBe(2);
      expect(payload.removedRules).toBe(3);
      expect(payload.closedSessions).toBe(2);
      expect(payload.removedRuleIds).toEqual(["default-removed", "explicit-removed", "stop-false"]);
      expect(payload.closedSessionIds).toEqual([
        "heartbeat:default-removed",
        "heartbeat:session-changed",
      ]);

      expect(stopCalls).toEqual([
        {
          sessionId: "heartbeat:default-removed",
          reason: "heartbeat_rule_removed",
          timeoutMs: undefined,
        },
        {
          sessionId: "heartbeat:session-changed",
          reason: "heartbeat_rule_removed",
          timeoutMs: undefined,
        },
        {
          sessionId: "heartbeat:stop-false",
          reason: "heartbeat_rule_removed",
          timeoutMs: undefined,
        },
      ]);
      expect(stopCalls.some((call) => call.sessionId === "shared-session")).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  test("heartbeat.reload does not close removed default session when still referenced by active rules", async () => {
    const harness = createDaemonHarness([
      {
        id: "legacy",
        intervalMinutes: 5,
        prompt: "old",
      },
    ]);

    try {
      writeHeartbeatPolicy(harness.policyPath, [
        {
          id: "consumer",
          intervalMinutes: 5,
          prompt: "new",
          sessionId: "heartbeat:legacy",
        },
      ]);

      const supervisor = Reflect.get(harness.daemon, "supervisor") as {
        stopSession: (sessionId: string, reason?: string, timeoutMs?: number) => Promise<boolean>;
      };
      const stopCalls: string[] = [];
      supervisor.stopSession = async (sessionId) => {
        stopCalls.push(sessionId);
        return true;
      };

      const handleMethod = getHandleMethod(harness.daemon);
      const payload = (await handleMethod("heartbeat.reload", {})) as ReloadPayload;

      expect(payload.rules).toBe(1);
      expect(payload.removedRuleIds).toEqual(["legacy"]);
      expect(payload.closedSessionIds).toEqual([]);
      expect(stopCalls).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test("idle sweep closes only truly idle sessions", async () => {
    const harness = createDaemonHarness([], {
      sessionIdleTtlMs: 5_000,
      sessionIdleSweepIntervalMs: 1_000,
    });

    try {
      const supervisor = getSupervisorForTest(harness.daemon);
      const now = Date.now();
      supervisor.workers.clear();
      supervisor.workers.set(
        "idle-target",
        createSupervisorWorker({
          sessionId: "idle-target",
          now,
          lastActivityOffsetMs: 8_000,
        }),
      );
      supervisor.workers.set(
        "pending-busy",
        createSupervisorWorker({
          sessionId: "pending-busy",
          now,
          lastActivityOffsetMs: 8_000,
          pendingCount: 1,
        }),
      );
      supervisor.workers.set(
        "ready-busy",
        createSupervisorWorker({
          sessionId: "ready-busy",
          now,
          lastActivityOffsetMs: 8_000,
          readyRequestId: "ready-1",
        }),
      );
      supervisor.workers.set(
        "fresh",
        createSupervisorWorker({
          sessionId: "fresh",
          now,
          lastActivityOffsetMs: 1_000,
        }),
      );

      const stopCalls: Array<{ sessionId: string; reason?: string; timeoutMs?: number }> = [];
      supervisor.stopSession = async (sessionId, reason, timeoutMs) => {
        stopCalls.push({ sessionId, reason, timeoutMs });
        return true;
      };

      const sweepIdleSessions = Reflect.get(
        supervisor as object,
        "sweepIdleSessions",
      ) as () => Promise<void>;
      await sweepIdleSessions.call(supervisor);

      expect(stopCalls).toEqual([
        {
          sessionId: "idle-target",
          reason: "idle_timeout",
          timeoutMs: undefined,
        },
      ]);
    } finally {
      harness.dispose();
    }
  });

  test("idle sweep continues when stopping one idle session fails", async () => {
    const harness = createDaemonHarness([], {
      sessionIdleTtlMs: 5_000,
      sessionIdleSweepIntervalMs: 1_000,
    });

    try {
      const supervisor = getSupervisorForTest(harness.daemon);
      const now = Date.now();
      supervisor.workers.clear();
      supervisor.workers.set(
        "idle-fail",
        createSupervisorWorker({
          sessionId: "idle-fail",
          now,
          lastActivityOffsetMs: 9_000,
        }),
      );
      supervisor.workers.set(
        "idle-next",
        createSupervisorWorker({
          sessionId: "idle-next",
          now,
          lastActivityOffsetMs: 9_500,
        }),
      );

      const stopCalls: string[] = [];
      supervisor.stopSession = async (sessionId) => {
        stopCalls.push(sessionId);
        if (sessionId === "idle-fail") {
          throw new Error("simulated stop failure");
        }
        return true;
      };

      const sweepIdleSessions = Reflect.get(
        supervisor as object,
        "sweepIdleSessions",
      ) as () => Promise<void>;
      await sweepIdleSessions.call(supervisor);
      expect(stopCalls).toEqual(["idle-fail", "idle-next"]);
    } finally {
      harness.dispose();
    }
  });
});
