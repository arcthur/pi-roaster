import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  WATCHDOG_BLOCKER_ID,
  WATCHDOG_BLOCKER_SOURCE,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-watchdog-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("task watchdog cleanup", () => {
  test("clears persisted watchdog blocker on turn start after semantic progress resumes", () => {
    const originalNow = Date.now;
    let now = 1_730_000_000_000;

    Date.now = () => now;
    try {
      const runtime = new BrewvaRuntime({ cwd: createWorkspace("cleanup") });
      const sessionId = "watchdog-cleanup-1";

      now = 1_730_000_000_100;
      runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Resume work after a previous stall",
      });

      now = 1_730_000_000_200;
      runtime.task.recordBlocker(sessionId, {
        id: WATCHDOG_BLOCKER_ID,
        message: "watchdog stall detected",
        source: WATCHDOG_BLOCKER_SOURCE,
      });

      now = 1_730_000_000_300;
      runtime.task.addItem(sessionId, {
        text: "Semantic progress resumes with a new task item",
      });

      const blocked = runtime.task.getState(sessionId);
      expect(blocked.blockers.some((entry) => entry.id === WATCHDOG_BLOCKER_ID)).toBe(true);
      expect(blocked.status?.phase).toBe("blocked");

      now = 1_730_000_000_400;
      runtime.context.onTurnStart(sessionId, 1);

      const cleared = runtime.task.getState(sessionId);
      expect(cleared.blockers.some((entry) => entry.id === WATCHDOG_BLOCKER_ID)).toBe(false);
      expect(cleared.status?.phase).toBe("execute");

      const clearEvent = runtime.events.query(sessionId, {
        type: "task_stuck_cleared",
        last: 1,
      })[0];
      expect(clearEvent?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        blockerId: WATCHDOG_BLOCKER_ID,
        detectedAt: 1_730_000_000_200,
        clearedAt: 1_730_000_000_400,
        resumedProgressAt: 1_730_000_000_300,
      });
    } finally {
      Date.now = originalNow;
    }
  });
});
