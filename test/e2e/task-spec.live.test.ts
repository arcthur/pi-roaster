import { describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCliSuccess,
  cleanupWorkspace,
  createWorkspace,
  findFinalBundle,
  isRecord,
  parseJsonLines,
  runCliSync,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

type TaskSpecSetPayload = {
  kind: "spec_set";
  spec: {
    schema: "brewva.task.v1";
    goal: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function findTaskSpecSetPayload(events: Array<{ type?: string; payload?: unknown }>): TaskSpecSetPayload | undefined {
  for (const event of events) {
    if (event.type !== "task_event") continue;
    if (!isRecord(event.payload)) continue;
    if (event.payload.kind !== "spec_set") continue;
    if (!isRecord(event.payload.spec)) continue;
    if (event.payload.spec.schema !== "brewva.task.v1") continue;
    if (typeof event.payload.spec.goal !== "string") continue;

    return event.payload as TaskSpecSetPayload;
  }
  return undefined;
}

describe("e2e: task spec plumbing", () => {
  runLive("--task is persisted as task_event spec_set", () => {
    const workspace = createWorkspace("task-spec");
    writeMinimalConfig(workspace);

    const goal = "Validate task plumbing";
    const taskSpec = {
      schema: "brewva.task.v1",
      goal,
      constraints: ["Keep output deterministic"],
    };

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "--task",
        JSON.stringify(taskSpec),
      ]);

      assertCliSuccess(run, "task-spec-inline");

      const bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
      expect(bundle).toBeDefined();

      const payload = findTaskSpecSetPayload(bundle?.events ?? []);
      expect(payload).toBeDefined();
      expect(payload?.kind).toBe("spec_set");
      expect(payload?.spec.schema).toBe("brewva.task.v1");
      expect(payload?.spec.goal).toBe(goal);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("--task-file is persisted as task_event spec_set", () => {
    const workspace = createWorkspace("task-file");
    writeMinimalConfig(workspace);

    const goal = "Validate task file plumbing";
    const taskSpec = {
      schema: "brewva.task.v1",
      goal,
      verification: {
        level: "quick",
      },
    };

    const taskFile = join(workspace, "task.json");
    writeFileSync(taskFile, JSON.stringify(taskSpec, null, 2), "utf8");

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "--task-file",
        taskFile,
      ]);

      assertCliSuccess(run, "task-spec-file");

      const bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
      expect(bundle).toBeDefined();

      const payload = findTaskSpecSetPayload(bundle?.events ?? []);
      expect(payload).toBeDefined();
      expect(payload?.kind).toBe("spec_set");
      expect(payload?.spec.schema).toBe("brewva.task.v1");
      expect(payload?.spec.goal).toBe(goal);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("rejects using --task and --task-file together", () => {
    const workspace = createWorkspace("task-conflict");
    writeMinimalConfig(workspace);

    const taskFile = join(workspace, "task.json");
    writeFileSync(
      taskFile,
      JSON.stringify(
        {
          schema: "brewva.task.v1",
          goal: "Task file goal",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "--task",
        JSON.stringify({
          schema: "brewva.task.v1",
          goal: "Inline goal",
        }),
        "--task-file",
        taskFile,
      ]);

      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr.includes("Error: use only one of --task or --task-file.")).toBe(
        true,
      );
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("rejects invalid inline --task json", () => {
    const workspace = createWorkspace("task-invalid-json");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "--task",
        "{invalid-json",
      ]);

      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr.includes("Error: failed to parse TaskSpec JSON (")).toBe(
        true,
      );
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("rejects unreadable --task-file path", () => {
    const workspace = createWorkspace("task-unreadable-file");
    writeMinimalConfig(workspace);

    const missingTaskFile = join(workspace, "missing-task.json");

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "--task-file",
        missingTaskFile,
      ]);

      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr.includes("Error: failed to read TaskSpec file (")).toBe(
        true,
      );
      expect(run.stderr.includes("missing-task.json")).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
