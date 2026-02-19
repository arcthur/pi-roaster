import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Task status alignment", () => {
  test("computes phase/health before agent start", () => {
    const workspace = createWorkspace("task-status");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-1";

    const injection1 = runtime.buildContextInjection(sessionId, "hello");
    expect(injection1.text.includes("[TaskLedger]")).toBe(true);
    expect(injection1.text.includes("status.phase=align")).toBe(true);
    expect(injection1.text.includes("status.health=needs_spec")).toBe(true);

    runtime.setTaskSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    const injection2 = runtime.buildContextInjection(sessionId, "next");
    expect(injection2.text.includes("status.phase=investigate")).toBe(true);

    runtime.addTaskItem(sessionId, { text: "Implement the fix" });
    const injection3 = runtime.buildContextInjection(sessionId, "next");
    expect(injection3.text.includes("status.phase=execute")).toBe(true);
  });

  test("keeps health as ok for sub-1 percentage-point telemetry", () => {
    const workspace = createWorkspace("task-status-percent");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-2";

    runtime.setTaskSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.addTaskItem(sessionId, { text: "Implement the fix" });

    const injection = runtime.buildContextInjection(sessionId, "next", {
      tokens: 2688,
      contextWindow: 272000,
      percent: 0.9886,
    });
    expect(injection.text.includes("status.phase=execute")).toBe(true);
    expect(injection.text.includes("status.health=ok")).toBe(true);
    expect(injection.text.includes("status.health=budget_pressure")).toBe(false);
  });
});
