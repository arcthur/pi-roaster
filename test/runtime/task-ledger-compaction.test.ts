import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { RoasterRuntime, TASK_EVENT_TYPE } from "@pi-roaster/roaster-runtime";
import type { TaskSpec } from "@pi-roaster/roaster-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `roaster-${name}-`));
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function eventLogPath(workspace: string, sessionId: string): string {
  return join(workspace, ".orchestrator/events", `${sanitizeSessionId(sessionId)}.jsonl`);
}

function taskSnapshotPath(workspace: string, sessionId: string): string {
  return join(workspace, ".orchestrator/state/task-ledger", `${sanitizeSessionId(sessionId)}.json`);
}

function taskArchivePath(workspace: string, sessionId: string): string {
  return join(workspace, ".orchestrator/state/task-ledger/archive", `${sanitizeSessionId(sessionId)}.jsonl`);
}

describe("Task ledger compaction", () => {
  test("replaces old task events with checkpoint and preserves full state via replay", () => {
    const workspace = createWorkspace("task-ledger-compaction");
    const sessionId = "task-ledger-compaction-1";
    const runtime = new RoasterRuntime({ cwd: workspace });

    const spec: TaskSpec = {
      schema: "roaster.task.v1",
      goal: "Keep task replay fast via checkpoint compaction",
    };
    runtime.setTaskSpec(sessionId, spec);

    const itemCount = 240;
    const padding = "x".repeat(220);
    for (let i = 0; i < itemCount; i += 1) {
      runtime.addTaskItem(sessionId, { text: `item-${i} ${padding}` });
    }

    const logPath = eventLogPath(workspace, sessionId);
    const beforeSize = existsSync(logPath) ? statSync(logPath).size : 0;
    expect(beforeSize).toBeGreaterThan(0);

    runtime.persistSessionSnapshot(sessionId, { reason: "manual", interrupted: false });

    const afterSize = existsSync(logPath) ? statSync(logPath).size : 0;
    expect(afterSize).toBeLessThan(beforeSize);

    const events = readFileSync(logPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });

    const taskEvents = events.filter((event) => event.type === TASK_EVENT_TYPE);
    expect(taskEvents.length).toBeLessThan(140);
    expect(taskEvents.some((event) => (event.payload as { kind?: string } | undefined)?.kind === "checkpoint_set")).toBe(true);

    const compactionEvents = events.filter((event) => event.type === "task_ledger_compacted");
    expect(compactionEvents.length).toBe(1);
    const compactionPayload = compactionEvents[0]?.payload ?? {};
    expect(compactionPayload.bytesBefore).toBe(beforeSize);
    expect(typeof compactionPayload.bytesAfter).toBe("number");
    expect(compactionPayload.bytesAfter as number).toBeLessThan(beforeSize);
    expect(compactionPayload.compacted as number).toBeGreaterThan(0);
    expect(compactionPayload.kept as number).toBeGreaterThan(0);
    expect(typeof compactionPayload.durationMs).toBe("number");
    expect(compactionPayload.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(typeof compactionPayload.checkpointEventId).toBe("string");

    const archivePath = taskArchivePath(workspace, sessionId);
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, "utf8").includes("roaster.task.ledger.archive.v1")).toBe(true);

    rmSync(taskSnapshotPath(workspace, sessionId), { force: true });

    const runtime2 = new RoasterRuntime({ cwd: workspace });
    const state = runtime2.getTaskState(sessionId);
    expect(state.items.length).toBe(itemCount);
    expect(state.spec?.goal).toBe(spec.goal);
  });
});
