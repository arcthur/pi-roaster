import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSupervisor } from "@brewva/brewva-gateway";
import { BrewvaRuntime, WATCHDOG_BLOCKER_ID } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-supervisor-watchdog-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

async function waitForCondition<T>(
  check: () => T | null | undefined,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    message: string;
  },
): Promise<T> {
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  const intervalMs = Math.max(25, options.intervalMs ?? 100);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
  }

  throw new Error(options.message);
}

async function sleepMs(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref?.();
  });
}

function createWorkerTestEnv(overrides: {
  taskGoal: string;
  pollIntervalMs: number;
  investigateMs: number;
}): Record<string, string | undefined> {
  return {
    BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES: "1",
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL: overrides.taskGoal,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS: String(overrides.pollIntervalMs),
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_INVESTIGATE_MS: String(overrides.investigateMs),
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_EXECUTE_MS: undefined,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_VERIFY_MS: undefined,
  };
}

describe("session supervisor watchdog bridge", () => {
  test("worker process persists watchdog detection and blocker state after init", async () => {
    const workspace = createWorkspace("worker-bridge");
    const supervisor = new SessionSupervisor({
      stateDir: join(workspace, "state"),
      defaultCwd: workspace,
      defaultEnableExtensions: false,
      workerEnv: createWorkerTestEnv({
        taskGoal: "Detect stalled runtime work from the worker process",
        pollIntervalMs: 1_000,
        investigateMs: 1_000,
      }),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });

    try {
      const opened = await supervisor.openSession({
        sessionId: "watchdog-worker-bridge",
      });
      const agentSessionId = opened.agentSessionId;
      expect(typeof agentSessionId).toBe("string");
      expect(agentSessionId?.length).toBeGreaterThan(0);

      const detected = await waitForCondition(
        () => {
          if (!agentSessionId) return null;
          const observer = new BrewvaRuntime({ cwd: workspace });
          return observer.events.query(agentSessionId, {
            type: "task_stuck_detected",
            last: 1,
          })[0];
        },
        {
          timeoutMs: 8_000,
          intervalMs: 100,
          message: "expected worker watchdog detection event",
        },
      );

      expect(detected.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        phase: "investigate",
        thresholdMs: 1_000,
        blockerWritten: true,
        blockerId: WATCHDOG_BLOCKER_ID,
      });

      const observer = new BrewvaRuntime({ cwd: workspace });
      const taskState = observer.task.getState(agentSessionId!);
      expect(taskState.blockers.some((blocker) => blocker.id === WATCHDOG_BLOCKER_ID)).toBe(true);
      expect(taskState.status?.phase).toBe("blocked");
    } finally {
      await supervisor.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stopSession shuts down worker before watchdog can emit stuck state", async () => {
    const workspace = createWorkspace("worker-stop");
    const supervisor = new SessionSupervisor({
      stateDir: join(workspace, "state"),
      defaultCwd: workspace,
      defaultEnableExtensions: false,
      workerEnv: createWorkerTestEnv({
        taskGoal: "Ensure shutdown stops watchdog polling before detection",
        pollIntervalMs: 2_000,
        investigateMs: 2_000,
      }),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });

    try {
      const opened = await supervisor.openSession({
        sessionId: "watchdog-worker-stop",
      });
      const agentSessionId = opened.agentSessionId;
      expect(typeof agentSessionId).toBe("string");
      expect(agentSessionId?.length).toBeGreaterThan(0);

      const stopped = await supervisor.stopSession("watchdog-worker-stop", "test_shutdown");
      expect(stopped).toBe(true);

      await sleepMs(3_000);

      const observer = new BrewvaRuntime({ cwd: workspace });
      expect(
        observer.events.query(agentSessionId!, {
          type: "task_stuck_detected",
        }),
      ).toHaveLength(0);

      const taskState = observer.task.getState(agentSessionId!);
      expect(taskState.blockers.some((blocker) => blocker.id === WATCHDOG_BLOCKER_ID)).toBe(false);
    } finally {
      await supervisor.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("ambient watchdog env is ignored without explicit worker test overrides", async () => {
    const workspace = createWorkspace("worker-ambient-env");
    const previousGoal = process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL;
    const previousPoll = process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS;
    const previousInvestigate = process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_INVESTIGATE_MS;
    const previousTestFlag = process.env.BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES;
    process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL =
      "This ambient env should not bootstrap worker task state";
    process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS = "1000";
    process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_INVESTIGATE_MS = "1000";
    delete process.env.BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES;

    const supervisor = new SessionSupervisor({
      stateDir: join(workspace, "state"),
      defaultCwd: workspace,
      defaultEnableExtensions: false,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });

    try {
      const opened = await supervisor.openSession({
        sessionId: "watchdog-worker-ambient-env",
      });
      const agentSessionId = opened.agentSessionId;
      expect(typeof agentSessionId).toBe("string");
      expect(agentSessionId?.length).toBeGreaterThan(0);

      await sleepMs(1_500);

      const observer = new BrewvaRuntime({ cwd: workspace });
      expect(observer.events.query(agentSessionId!, { type: "task_stuck_detected" })).toHaveLength(
        0,
      );
      expect(observer.task.getState(agentSessionId!).spec).toBeUndefined();
    } finally {
      await supervisor.stop();
      if (typeof previousGoal === "string") {
        process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL = previousGoal;
      } else {
        delete process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL;
      }
      if (typeof previousPoll === "string") {
        process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS = previousPoll;
      } else {
        delete process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS;
      }
      if (typeof previousInvestigate === "string") {
        process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_INVESTIGATE_MS = previousInvestigate;
      } else {
        delete process.env.BREWVA_INTERNAL_GATEWAY_WATCHDOG_INVESTIGATE_MS;
      }
      if (typeof previousTestFlag === "string") {
        process.env.BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES = previousTestFlag;
      } else {
        delete process.env.BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES;
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
