import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewaySession } from "../../packages/brewva-gateway/src/session/create-session.js";
import { TaskProgressWatchdog } from "../../packages/brewva-gateway/src/session/task-progress-watchdog.js";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-gateway-session-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("gateway session watchdog integration", () => {
  test("records watchdog detection for a real gateway session id", async () => {
    const originalNow = Date.now;
    let now = 1_740_000_000_000;
    let scheduledCallback: (() => void) | null = null;
    const intervalHandle = setInterval(() => {}, 60_000);
    clearInterval(intervalHandle);

    Date.now = () => now;
    const result = await createGatewaySession({
      cwd: createWorkspace("watchdog-session"),
      enableExtensions: false,
    });

    try {
      const sessionId = result.session.sessionManager.getSessionId();

      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      expect(bootstrap?.sessionId).toBe(sessionId);

      now = 1_740_000_000_100;
      result.runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Detect stalled work on a real gateway-backed session",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime: result.runtime,
        sessionId,
        now: () => now,
        pollIntervalMs: 2_000,
        thresholdsMs: {
          investigate: 2_000,
        },
        setIntervalFn: (callback) => {
          scheduledCallback = callback;
          return intervalHandle;
        },
        clearIntervalFn: () => {
          scheduledCallback = null;
        },
      });

      watchdog.start();
      expect(typeof scheduledCallback).toBe("function");

      now += 2_001;
      const triggerPoll =
        scheduledCallback ??
        (() => {
          throw new Error("expected scheduled watchdog poll");
        });
      triggerPoll();

      const detected = result.runtime.events.query(sessionId, {
        type: "task_stuck_detected",
        last: 1,
      })[0];
      expect(detected?.sessionId).toBe(sessionId);
      expect(detected?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        phase: "investigate",
        thresholdMs: 2_000,
        blockerWritten: true,
      });

      watchdog.stop();
    } finally {
      Date.now = originalNow;
      result.session.dispose();
    }
  });
});
