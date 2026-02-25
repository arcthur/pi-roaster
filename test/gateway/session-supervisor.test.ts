import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionBackendCapacityError,
  SessionBackendStateError,
  SessionSupervisor,
} from "@brewva/brewva-gateway";

describe("session supervisor safeguards", () => {
  test("given worker limit reached and queue disabled, when openSession is called, then capacity error is raised", async () => {
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
      supervisor.testHooks.seedWorker({
        sessionId: "existing",
        pid: 10001,
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

  test("given seeded workers, when persisting registry, then file is written atomically without tmp residue", () => {
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
      supervisor.testHooks.seedWorker({
        sessionId: "s1",
        pid: 10011,
      });
      supervisor.testHooks.persistRegistry();

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

  test("given injected state store, when persisting registry, then store write path is used", () => {
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
      supervisor.testHooks.seedWorker({
        sessionId: "s1",
        pid: 10021,
      });
      supervisor.testHooks.persistRegistry();

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

  test("given unknown session id, when sendPrompt is called, then typed session_not_found error is returned", async () => {
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

  test("given worker returns session_busy, when result is dispatched, then typed SessionBackendStateError is propagated", () => {
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

      supervisor.testHooks.seedWorker({
        sessionId: "busy-session",
        pid: 10031,
        pendingRequests: [
          {
            requestId: "req-1",
            resolve: () => undefined,
            reject: (error: Error) => {
              rejectCalls.push(error);
            },
            timer: pendingTimer,
          },
        ],
      });

      supervisor.testHooks.dispatchWorkerMessage("busy-session", {
        kind: "result",
        requestId: "req-1",
        ok: false,
        error: "session is busy with active turn: turn-1",
        errorCode: "session_busy",
      });

      expect(rejectCalls.length).toBe(1);
      expect(rejectCalls[0]).toBeInstanceOf(SessionBackendStateError);
      expect((rejectCalls[0] as SessionBackendStateError).code).toBe("session_busy");
      const pendingRequests = supervisor
        .listWorkers()
        .find((worker) => worker.sessionId === "busy-session")?.pendingRequests;
      expect(pendingRequests).toBe(0);
      clearTimeout(pendingTimer);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
