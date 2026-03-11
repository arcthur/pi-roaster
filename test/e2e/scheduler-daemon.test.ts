import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  buildScheduleIntentCreatedEvent,
} from "@brewva/brewva-runtime";
import { buildWorkerTestHarnessEnv } from "../../packages/brewva-gateway/src/session/worker-test-harness.js";
import { cleanupWorkspace, createWorkspace, repoRoot, writeMinimalConfig } from "./helpers.js";

interface DaemonProcess {
  child: ChildProcess;
  readStdout(): string;
  readStderr(): string;
}

async function waitForCondition<T>(
  check: () => T | null | undefined,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    message: string;
    daemon?: DaemonProcess;
  },
): Promise<T> {
  const timeoutMs = Math.max(500, options.timeoutMs ?? 12_000);
  const intervalMs = Math.max(50, options.intervalMs ?? 150);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = check();
    if (value !== null && value !== undefined) {
      return value;
    }

    const exitCode = options.daemon?.child.exitCode;
    if (exitCode !== null && exitCode !== undefined) {
      const stderr = options.daemon?.readStderr() ?? "";
      const stdout = options.daemon?.readStdout() ?? "";
      throw new Error(
        [
          options.message,
          `daemon exited early with code ${exitCode}`,
          stderr ? `stderr:\n${stderr}` : "",
          stdout ? `stdout:\n${stdout}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
  }

  const stderr = options.daemon?.readStderr() ?? "";
  const stdout = options.daemon?.readStdout() ?? "";
  throw new Error(
    [options.message, stderr ? `stderr:\n${stderr}` : "", stdout ? `stdout:\n${stdout}` : ""]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function startSchedulerDaemon(workspace: string): DaemonProcess {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const child = spawn("bun", ["run", "start", "--cwd", workspace, "--daemon", "--no-addons"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...buildWorkerTestHarnessEnv({
        fakeAssistantText: "SCHEDULE_DAEMON_TEST_OK",
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("expected scheduler daemon stdio pipes");
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  return {
    child,
    readStdout: () => stdoutChunks.join(""),
    readStderr: () => stderrChunks.join(""),
  };
}

async function stopSchedulerDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      daemon.child.kill("SIGKILL");
      reject(
        new Error(
          [
            "scheduler daemon did not stop after SIGTERM",
            daemon.readStderr() ? `stderr:\n${daemon.readStderr()}` : "",
            daemon.readStdout() ? `stdout:\n${daemon.readStdout()}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    }, 8_000);
    timer.unref?.();

    daemon.child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal && signal !== "SIGTERM") {
        reject(new Error(`scheduler daemon exited via signal ${signal}`));
        return;
      }
      if (code !== null && code !== 0) {
        reject(
          new Error(
            [
              `scheduler daemon exited with code ${code}`,
              daemon.readStderr() ? `stderr:\n${daemon.readStderr()}` : "",
              daemon.readStdout() ? `stdout:\n${daemon.readStdout()}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        );
        return;
      }
      resolve();
    });

    daemon.child.kill("SIGTERM");
  });
}

describe("e2e: scheduler daemon", () => {
  test("daemon catch-up executes a scheduled run through the shared session backend", async () => {
    const workspace = createWorkspace("scheduler-daemon");
    writeMinimalConfig(workspace, {
      infrastructure: {
        events: {
          enabled: true,
        },
      },
    });
    mkdirSync(join(workspace, ".brewva"), { recursive: true });

    const parentSessionId = "scheduler-parent-session";
    const parentTaskGoal = "Finish the release checklist";
    const truthSummary = "Release notes are waiting for final reviewer approval.";

    const setupRuntime = new BrewvaRuntime({ cwd: workspace });
    setupRuntime.task.setSpec(parentSessionId, {
      schema: "brewva.task.v1",
      goal: parentTaskGoal,
    });
    setupRuntime.truth.upsertFact(parentSessionId, {
      id: "fact-release-review",
      kind: "status",
      severity: "warn",
      summary: truthSummary,
    });
    setupRuntime.events.recordTapeHandoff(parentSessionId, {
      name: "release-checkpoint",
      summary: "Release prep is partially complete.",
      nextSteps: "Resolve the final reviewer comment.",
    });
    setupRuntime.events.record({
      sessionId: parentSessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-scheduler-daemon",
        parentSessionId,
        reason: "nightly release follow-up",
        continuityMode: "inherit",
        runAt: Date.now() - 1_000,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const daemon = startSchedulerDaemon(workspace);

    try {
      const observer = new BrewvaRuntime({ cwd: workspace });
      const started = await waitForCondition(
        () =>
          observer.events.query(parentSessionId, {
            type: SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
            last: 1,
          })[0],
        {
          message: "expected scheduler daemon to start a child session",
          daemon,
        },
      );
      const childSessionId =
        typeof started?.payload?.childSessionId === "string" ? started.payload.childSessionId : "";
      expect(childSessionId.length).toBeGreaterThan(0);

      await waitForCondition(
        () =>
          observer.events.query(parentSessionId, {
            type: SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
            last: 1,
          })[0],
        {
          message: "expected scheduler daemon to finish the scheduled child session",
          daemon,
        },
      );

      const persisted = new BrewvaRuntime({ cwd: workspace });
      const wakeup = persisted.events.query(childSessionId, {
        type: SCHEDULE_WAKEUP_EVENT_TYPE,
        last: 1,
      })[0];
      expect(wakeup?.payload).toMatchObject({
        intentId: "intent-scheduler-daemon",
        parentSessionId,
        inheritedTaskSpec: true,
        inheritedTruthFacts: 1,
      });

      const childTask = persisted.task.getState(childSessionId);
      expect(childTask.spec?.goal).toBe(parentTaskGoal);

      const childTruth = persisted.truth.getState(childSessionId);
      expect(childTruth.facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "fact-release-review",
            summary: truthSummary,
            status: "active",
          }),
        ]),
      );

      const childTapeStatus = persisted.events.getTapeStatus(childSessionId);
      expect(childTapeStatus.lastAnchor?.name).toBe("schedule:inherit:release-checkpoint");
    } finally {
      await stopSchedulerDaemon(daemon);
      cleanupWorkspace(workspace);
    }
  });
});
