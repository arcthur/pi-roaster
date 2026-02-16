import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { RoasterRuntime, TASK_EVENT_TYPE, buildItemAddedEvent } from "@pi-roaster/roaster-runtime";
import type { TaskSpec } from "@pi-roaster/roaster-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `roaster-${name}-`));
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  return workspace;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function snapshotPath(workspace: string, sessionId: string): string {
  return join(workspace, ".orchestrator/state/task-ledger", `${sanitizeSessionId(sessionId)}.json`);
}

function eventLogPath(workspace: string, sessionId: string): string {
  return join(workspace, ".orchestrator/events", `${sanitizeSessionId(sessionId)}.jsonl`);
}

describe("Task ledger snapshots", () => {
  test("persists per-session snapshot alongside task events", () => {
    const workspace = createWorkspace("task-ledger-snap");
    const runtime = new RoasterRuntime({ cwd: workspace });
    const sessionId = "task-ledger-snap-1";

    const spec: TaskSpec = {
      schema: "roaster.task.v1",
      goal: "Reduce getTaskState replay time",
    };
    runtime.setTaskSpec(sessionId, spec);
    runtime.addTaskItem(sessionId, { text: "Add snapshot store", status: "doing" });

    const snapPath = snapshotPath(workspace, sessionId);
    expect(existsSync(snapPath)).toBe(true);

    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as {
      version: number;
      sessionId: string;
      logOffsetBytes: number;
      state: { spec?: { goal?: string } };
    };
    expect(snap.version).toBe(1);
    expect(snap.sessionId).toBe(sessionId);
    expect(snap.logOffsetBytes).toBeGreaterThan(0);
    expect(snap.state.spec?.goal).toBe("Reduce getTaskState replay time");

    const logPath = eventLogPath(workspace, sessionId);
    expect(snap.logOffsetBytes).toBe(statSync(logPath).size);
  });

  test("hydrates from snapshot and catches up on newly appended task events", () => {
    const workspace = createWorkspace("task-ledger-catchup");
    const sessionId = "task-ledger-catchup-1";

    const runtime1 = new RoasterRuntime({ cwd: workspace });
    runtime1.setTaskSpec(sessionId, {
      schema: "roaster.task.v1",
      goal: "Catch up task snapshot",
    });

    const snapPath = snapshotPath(workspace, sessionId);
    const initialSnap = JSON.parse(readFileSync(snapPath, "utf8")) as { logOffsetBytes: number };
    const logPath = eventLogPath(workspace, sessionId);
    const beforeSize = statSync(logPath).size;
    expect(initialSnap.logOffsetBytes).toBe(beforeSize);

    const manualEvent = {
      id: `evt_${Date.now()}_manual`,
      sessionId,
      type: TASK_EVENT_TYPE,
      timestamp: Date.now() + 10,
      payload: buildItemAddedEvent({ text: "manual tail item", status: "todo" }),
    };
    appendFileSync(logPath, `\n${JSON.stringify(manualEvent)}`, "utf8");
    const afterSize = statSync(logPath).size;
    expect(afterSize).toBeGreaterThan(beforeSize);

    const runtime2 = new RoasterRuntime({ cwd: workspace });
    const state = runtime2.getTaskState(sessionId);
    expect(state.items.some((item) => item.text === "manual tail item")).toBe(true);

    const updatedSnap = JSON.parse(readFileSync(snapPath, "utf8")) as { logOffsetBytes: number; state: { items: Array<{ text: string }> } };
    expect(updatedSnap.logOffsetBytes).toBe(afterSize);
    expect(updatedSnap.state.items.some((item) => item.text === "manual tail item")).toBe(true);
  });
});

