import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { RoasterRuntime } from "@pi-roaster/roaster-runtime";
import type { TaskSpec } from "@pi-roaster/roaster-runtime";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "roaster-task-ledger-"));
}

describe("Task ledger", () => {
  test("records TaskSpec and returns folded state", () => {
    const workspace = createWorkspace();
    const runtime = new RoasterRuntime({ cwd: workspace });
    const sessionId = "task-1";

    const spec: TaskSpec = {
      schema: "roaster.task.v1",
      goal: "Fix failing tests in runtime",
      targets: {
        files: ["packages/roaster-runtime/src/runtime.ts"],
      },
      constraints: ["Do not change public CLI flags"],
    };

    runtime.setTaskSpec(sessionId, spec);

    const state = runtime.getTaskState(sessionId);
    expect(state.spec?.schema).toBe("roaster.task.v1");
    expect(state.spec?.goal).toBe("Fix failing tests in runtime");
    expect(state.spec?.targets?.files?.[0]).toBe("packages/roaster-runtime/src/runtime.ts");
    expect(state.spec?.constraints?.[0]).toBe("Do not change public CLI flags");
  });

  test("hydrates from task events without restoring snapshot", () => {
    const workspace = createWorkspace();
    const sessionId = "task-2";

    const runtime1 = new RoasterRuntime({ cwd: workspace });
    runtime1.setTaskSpec(sessionId, {
      schema: "roaster.task.v1",
      goal: "Refactor context injection",
    });

    const runtime2 = new RoasterRuntime({ cwd: workspace });
    const state = runtime2.getTaskState(sessionId);
    expect(state.spec?.goal).toBe("Refactor context injection");
  });

  test("persists and restores task state via session snapshot", () => {
    const workspace = createWorkspace();
    const sessionId = "task-snap";

    const runtime1 = new RoasterRuntime({ cwd: workspace });
    runtime1.setTaskSpec(sessionId, {
      schema: "roaster.task.v1",
      goal: "Implement TaskSpec v1",
    });
    runtime1.persistSessionSnapshot(sessionId, { reason: "manual", interrupted: false });

    const runtime2 = new RoasterRuntime({ cwd: workspace });
    const restored = runtime2.restoreSessionSnapshot(sessionId);
    expect(restored.restored).toBe(true);

    const state = runtime2.getTaskState(sessionId);
    expect(state.spec?.goal).toBe("Implement TaskSpec v1");
  });

  test("injects viewport context for TaskSpec target files", () => {
    const workspace = createWorkspace();
    const runtime = new RoasterRuntime({ cwd: workspace });
    const sessionId = "task-viewport";

    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src/bar.ts"),
      ["export interface Bar {", "  value: string;", "}"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(workspace, "src/foo.ts"),
      ['import type { Bar } from "./bar";', "export function useBar(bar: Bar): string {", "  return bar.value;", "}"].join(
        "\n",
      ),
      "utf8",
    );

    runtime.setTaskSpec(sessionId, {
      schema: "roaster.task.v1",
      goal: "Ensure Bar is wired correctly",
      targets: {
        files: ["src/foo.ts"],
      },
    });

    const injection = runtime.buildContextInjection(sessionId, "Ensure Bar is wired correctly");
    expect(injection.text.includes("[Viewport]")).toBe(true);
    expect(injection.text.includes("File: src/foo.ts")).toBe(true);
    expect(injection.text.includes("./bar Bar:")).toBe(true);
  });
});
