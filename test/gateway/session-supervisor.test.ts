import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionBackendCapacityError,
  SessionBackendStateError,
  SessionSupervisor,
  type SessionWorkerInfo,
} from "@brewva/brewva-gateway";

function createFakeWorker(sessionId: string): SessionWorkerInfo {
  const now = Date.now();
  return {
    sessionId,
    pid: 43210,
    startedAt: now - 5000,
    lastHeartbeatAt: now,
    lastActivityAt: now,
    pendingRequests: 0,
    agentSessionId: `agent-${sessionId}`,
    cwd: "/tmp",
  };
}

describe("session supervisor safeguards", () => {
  test("rejects openSession when worker limit is reached and queue is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
      maxWorkers: 1,
      maxPendingSessionOpens: 0,
    });
    try {
      const workers = Reflect.get(supervisor, "workers") as Map<string, unknown>;
      workers.set("existing", {
        ...createFakeWorker("existing"),
        child: { pid: 10001 },
        pending: new Map(),
      });

      let openError: unknown;
      try {
        await supervisor.openSession({
          sessionId: "new-session",
        });
      } catch (error) {
        openError = error;
      }
      expect(openError).toBeInstanceOf(SessionBackendCapacityError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists worker registry without leaving temporary files", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      const workers = Reflect.get(supervisor, "workers") as Map<string, unknown>;
      workers.set("s1", {
        ...createFakeWorker("s1"),
        child: { pid: 10011 },
        pending: new Map(),
      });

      const persistRegistry = Reflect.get(supervisor, "persistRegistry") as () => void;
      persistRegistry.call(supervisor);

      const registryPath = join(stateDir, "children.json");
      const tmpPath = `${registryPath}.tmp`;
      expect(existsSync(registryPath)).toBe(true);
      expect(existsSync(tmpPath)).toBe(false);

      const rows = JSON.parse(readFileSync(registryPath, "utf8")) as Array<{
        sessionId?: string;
        pid?: number;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.sessionId).toBe("s1");
      expect(rows[0]?.pid).toBe(10011);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses injected state store for registry persistence", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const calls: Array<{ kind: string; path: string }> = [];
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
      stateStore: {
        readToken: () => undefined,
        writeToken: () => {},
        readChildrenRegistry: (path) => {
          calls.push({ kind: "read", path });
          return [];
        },
        writeChildrenRegistry: (path) => {
          calls.push({ kind: "write", path });
        },
        removeChildrenRegistry: (path) => {
          calls.push({ kind: "remove", path });
        },
      },
    });
    try {
      const workers = Reflect.get(supervisor, "workers") as Map<string, unknown>;
      workers.set("s1", {
        ...createFakeWorker("s1"),
        child: { pid: 10021 },
        pending: new Map(),
        pendingTurns: new Map(),
      });

      const persistRegistry = Reflect.get(supervisor, "persistRegistry") as () => void;
      persistRegistry.call(supervisor);

      const registryPath = join(stateDir, "children.json");
      expect(calls).toEqual([
        {
          kind: "write",
          path: registryPath,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws typed session_not_found when sendPrompt targets unknown session", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      let sendError: unknown;
      try {
        await supervisor.sendPrompt("missing-session", "hello");
      } catch (error) {
        sendError = error;
      }
      expect(sendError).toBeInstanceOf(SessionBackendStateError);
      expect(sendError).toMatchObject({
        code: "session_not_found",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps worker session_busy result into typed SessionBackendStateError", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      const rejectCalls: Error[] = [];
      const pendingTimer = setTimeout(() => {}, 1_000);
      pendingTimer.unref?.();

      const handle = {
        sessionId: "busy-session",
        child: { pid: 10031, on: () => {}, send: () => {} },
        startedAt: Date.now() - 2_000,
        lastActivityAt: Date.now(),
        pending: new Map([
          [
            "req-1",
            {
              resolve: () => {},
              reject: (error: Error) => {
                rejectCalls.push(error);
              },
              timer: pendingTimer,
            },
          ],
        ]),
        pendingTurns: new Map(),
        lastHeartbeatAt: Date.now(),
      };

      const onWorkerMessage = Reflect.get(supervisor, "onWorkerMessage") as (
        workerHandle: unknown,
        message: unknown,
      ) => void;
      onWorkerMessage.call(supervisor, handle, {
        kind: "result",
        requestId: "req-1",
        ok: false,
        error: "session is busy with active turn: turn-1",
        errorCode: "session_busy",
      });

      expect(rejectCalls.length).toBe(1);
      expect(rejectCalls[0]).toBeInstanceOf(SessionBackendStateError);
      expect((rejectCalls[0] as SessionBackendStateError).code).toBe("session_busy");
      expect(handle.pending.size).toBe(0);
      clearTimeout(pendingTimer);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
