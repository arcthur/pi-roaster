import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  SCAN_CONVERGENCE_BLOCKER_ID,
  WATCHDOG_BLOCKER_ID,
  WATCHDOG_BLOCKER_SOURCE,
} from "@brewva/brewva-runtime";
import {
  TASK_PROGRESS_WATCHDOG_TEST_ONLY,
  TaskProgressWatchdog,
} from "../../packages/brewva-gateway/src/session/task-progress-watchdog.js";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-gateway-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("task progress watchdog", () => {
  test("records watchdog blocker and detection event when task makes no semantic progress", () => {
    const originalNow = Date.now;
    let now = 1_710_000_000_000;

    Date.now = () => now;
    try {
      const runtime = new BrewvaRuntime({ cwd: createWorkspace("watchdog-detect") });
      const sessionId = "watchdog-detect-1";

      now = 1_710_000_000_100;
      runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Detect long-running investigation stalls",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLDS_MS.investigate + 1;
      watchdog.poll();

      const state = runtime.task.getState(sessionId);
      const blocker = state.blockers.find((entry) => entry.id === WATCHDOG_BLOCKER_ID);
      expect(blocker?.source).toBe(WATCHDOG_BLOCKER_SOURCE);
      expect(state.status?.phase).toBe("blocked");

      const detected = runtime.events.query(sessionId, { type: "task_stuck_detected" });
      expect(detected).toHaveLength(1);
      expect(detected[0]?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        phase: "investigate",
        blockerWritten: true,
        blockerId: WATCHDOG_BLOCKER_ID,
        suppressedBy: null,
      });

      now += 60_000;
      watchdog.poll();
      expect(runtime.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(1);
    } finally {
      Date.now = originalNow;
    }
  });

  test("when scan convergence blocker is active, emits event without writing watchdog blocker", () => {
    const originalNow = Date.now;
    let now = 1_720_000_000_000;

    Date.now = () => now;
    try {
      const runtime = new BrewvaRuntime({ cwd: createWorkspace("watchdog-suppress") });
      const sessionId = "watchdog-suppress-1";

      now = 1_720_000_000_100;
      runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Respect targeted convergence guards",
      });

      now = 1_720_000_000_200;
      runtime.task.recordBlocker(sessionId, {
        id: SCAN_CONVERGENCE_BLOCKER_ID,
        message: "scan convergence guard armed",
        source: "scan_convergence_guard",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLDS_MS.investigate + 1;
      watchdog.poll();

      const state = runtime.task.getState(sessionId);
      expect(state.blockers.some((entry) => entry.id === WATCHDOG_BLOCKER_ID)).toBe(false);

      const detected = runtime.events.query(sessionId, {
        type: "task_stuck_detected",
        last: 1,
      })[0];
      expect(detected?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        blockerWritten: false,
        blockerId: null,
        suppressedBy: SCAN_CONVERGENCE_BLOCKER_ID,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("when scan convergence arms after watchdog blocked the task, resolves the broader watchdog blocker", () => {
    const originalNow = Date.now;
    let now = 1_722_000_000_000;

    Date.now = () => now;
    try {
      const runtime = new BrewvaRuntime({ cwd: createWorkspace("watchdog-superseded") });
      const sessionId = "watchdog-superseded-1";

      now = 1_722_000_000_100;
      runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Prefer the more specific convergence guard once it activates",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLDS_MS.investigate + 1;
      watchdog.poll();
      expect(
        runtime.task.getState(sessionId).blockers.some((entry) => entry.id === WATCHDOG_BLOCKER_ID),
      ).toBe(true);

      now += 100;
      runtime.task.recordBlocker(sessionId, {
        id: SCAN_CONVERGENCE_BLOCKER_ID,
        message: "scan convergence guard armed after watchdog escalation",
        source: "scan_convergence_guard",
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLDS_MS.investigate + 1;
      watchdog.poll();

      const state = runtime.task.getState(sessionId);
      expect(state.blockers.some((entry) => entry.id === WATCHDOG_BLOCKER_ID)).toBe(false);
      expect(state.blockers.some((entry) => entry.id === SCAN_CONVERGENCE_BLOCKER_ID)).toBe(true);

      const detected = runtime.events.query(sessionId, {
        type: "task_stuck_detected",
        last: 1,
      })[0];
      expect(detected?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        blockerWritten: false,
        suppressedBy: SCAN_CONVERGENCE_BLOCKER_ID,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("start schedules a single poller, stop clears it, and threshold policy sanitizes overrides", () => {
    const originalNow = Date.now;
    let now = 1_725_000_000_000;
    let scheduledCallback: (() => void) | null = null;
    let scheduledDelayMs = 0;
    let startCalls = 0;
    let stopCalls = 0;
    const intervalHandle = setInterval(() => {}, 60_000);
    clearInterval(intervalHandle);

    Date.now = () => now;
    try {
      const runtime = new BrewvaRuntime({ cwd: createWorkspace("watchdog-lifecycle") });
      const sessionId = "watchdog-lifecycle-1";

      now = 1_725_000_000_100;
      runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Exercise worker-local watchdog lifecycle wiring",
      });

      const policy = TASK_PROGRESS_WATCHDOG_TEST_ONLY.createThresholdPolicy({
        investigate: 250,
        verify: 3_250,
      });
      expect(policy.investigate).toBe(1_000);
      expect(policy.execute).toBe(TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLDS_MS.execute);
      expect(policy.verify).toBe(3_250);

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
        pollIntervalMs: 250,
        thresholdsMs: {
          investigate: 250,
        },
        setIntervalFn: (callback, delayMs) => {
          startCalls += 1;
          scheduledCallback = callback;
          scheduledDelayMs = delayMs;
          return intervalHandle;
        },
        clearIntervalFn: (handle) => {
          expect(handle).toBe(intervalHandle);
          stopCalls += 1;
        },
      });

      watchdog.start();
      watchdog.start();
      expect(startCalls).toBe(1);
      expect(scheduledDelayMs).toBe(1_000);
      expect(typeof scheduledCallback).toBe("function");

      now += 1_001;
      const triggerPoll =
        scheduledCallback ??
        (() => {
          throw new Error("expected scheduled watchdog poll");
        });
      triggerPoll();

      const detected = runtime.events.query(sessionId, {
        type: "task_stuck_detected",
        last: 1,
      })[0];
      expect(detected?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 1_000,
        blockerWritten: true,
      });

      watchdog.stop();
      watchdog.stop();
      expect(stopCalls).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });
});
