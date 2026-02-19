import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TaskSpec } from "@brewva/brewva-runtime";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-task-ledger-"));
}

describe("Task ledger", () => {
  test("records TaskSpec and returns folded state", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-1";

    const spec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Fix failing tests in runtime",
      targets: {
        files: ["packages/brewva-runtime/src/runtime.ts"],
      },
      constraints: ["Do not change public CLI flags"],
    };

    runtime.setTaskSpec(sessionId, spec);

    const state = runtime.getTaskState(sessionId);
    expect(state.spec?.schema).toBe("brewva.task.v1");
    expect(state.spec?.goal).toBe("Fix failing tests in runtime");
    expect(state.spec?.targets?.files?.[0]).toBe("packages/brewva-runtime/src/runtime.ts");
    expect(state.spec?.constraints?.[0]).toBe("Do not change public CLI flags");
  });

  test("hydrates from task events without restoring snapshot", () => {
    const workspace = createWorkspace();
    const sessionId = "task-2";

    const runtime1 = new BrewvaRuntime({ cwd: workspace });
    runtime1.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Refactor context injection",
    });

    const runtime2 = new BrewvaRuntime({ cwd: workspace });
    const state = runtime2.getTaskState(sessionId);
    expect(state.spec?.goal).toBe("Refactor context injection");
  });

  test("injects viewport context for TaskSpec target files", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
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
      schema: "brewva.task.v1",
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
