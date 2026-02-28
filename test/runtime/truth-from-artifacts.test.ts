import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Truth extraction from evidence artifacts", () => {
  test("records command_failure truth facts and clears on success", async () => {
    const workspace = createWorkspace("truth-from-artifacts");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-1";

    const failureOutput = [
      "FAIL src/foo.test.ts",
      "AssertionError: expected 1 to be 2",
      "    at Object.<anonymous> (/repo/src/foo.test.ts:12:7)",
    ].join("\n");

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: failureOutput,
      success: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth1 = runtime.truth.getState(sessionId);
    const fact1 = truth1.facts.find((fact) => fact.kind === "command_failure");
    expect(fact1).not.toBeUndefined();
    expect(fact1?.status).toBe("active");
    expect(fact1?.summary.includes("command failed: bun test")).toBe(true);

    const task1 = runtime.task.getState(sessionId);
    const blocker1 = task1.blockers.find((blocker) => blocker.id === fact1?.id);
    expect(blocker1).not.toBeUndefined();
    expect(blocker1?.truthFactId).toBe(fact1?.id);
    expect(blocker1?.message).toBe(fact1?.summary);

    const injection1 = await runtime.context.buildInjection(sessionId, "next");
    expect(injection1.text.includes("[TruthFacts]")).toBe(true);
    expect(injection1.text.includes(fact1?.id ?? "")).toBe(true);

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "",
      success: true,
      metadata: {
        details: { result: { exitCode: 0 } },
      },
    });

    const truth2 = runtime.truth.getState(sessionId);
    const fact2 = truth2.facts.find((fact) => fact.id === fact1?.id);
    expect(fact2).not.toBeUndefined();
    expect(fact2?.status).toBe("resolved");

    const task2 = runtime.task.getState(sessionId);
    expect(task2.blockers.some((blocker) => blocker.id === fact1?.id)).toBe(false);
  });

  test("does not create blockers for search no-match exit code", () => {
    const workspace = createWorkspace("truth-from-artifacts-nomatch");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-2";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'rg "needle" src' },
      outputText: "(no output)\n\nProcess exited with code 1.",
      success: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("does not create blockers for grep -c no-match exit code", () => {
    const workspace = createWorkspace("truth-from-artifacts-grep-count");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-3";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'grep -c "needle" src/file.ts' },
      outputText: "0\n\nProcess exited with code 1.",
      success: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("does not create blockers for git -C grep no-match exit code", () => {
    const workspace = createWorkspace("truth-from-artifacts-git-c-grep");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-4";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'git -C repo grep "needle" src' },
      outputText: "(no output)\n\nProcess exited with code 1.",
      success: false,
      metadata: {
        details: { result: { exitCode: 1 } },
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });

  test("does not create blockers when exitCode is parsed from output (CRLF)", () => {
    const workspace = createWorkspace("truth-from-artifacts-exitcode-output");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "truth-from-artifacts-5";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: 'rg "needle" src' },
      outputText: "(no output)\r\n\r\nProcess exited with code 1.",
      success: false,
      metadata: {
        details: {},
      },
    });

    const truth = runtime.truth.getState(sessionId);
    expect(
      truth.facts.some((fact) => fact.kind === "command_failure" && fact.status === "active"),
    ).toBe(false);

    const task = runtime.task.getState(sessionId);
    expect(task.blockers.length).toBe(0);
  });
});
