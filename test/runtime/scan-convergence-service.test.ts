import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createRuntime(workspace: string): BrewvaRuntime {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.tape.checkpointIntervalEntries = 0;
  return new BrewvaRuntime({ cwd: workspace, config });
}

function startAndFinishTool(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  success?: boolean;
  outputText?: string;
}): { allowed: boolean; reason?: string } {
  const started = input.runtime.tools.start({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args,
  });
  if (!started.allowed) {
    return started;
  }

  input.runtime.tools.finish({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args,
    outputText: input.outputText ?? `${input.toolName} output`,
    success: input.success !== false,
  });
  return started;
}

describe("scan convergence service", () => {
  test("arms after repeated scan-only turns and blocks subsequent low-signal tools", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      const started = startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-${turn}`,
        toolName: "read",
        args: { file_path: `src/file-${turn}.ts` },
        outputText: "line 1\nline 2",
      });
      expect(started.allowed).toBe(true);
      runtime.context.onTurnEnd(sessionId);
    }

    const blocker = runtime.task
      .getState(sessionId)
      .blockers.find((entry) => entry.id === "guard:scan-convergence");
    expect(blocker?.source).toBe("runtime.scan_convergence");

    runtime.context.onTurnStart(sessionId, 4);
    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-look-at-blocked",
      toolName: "look_at",
      args: { goal: "find the runtime facade" },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("Stop low-signal investigation")).toBe(true);

    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.toolStrategy).toBe("low_signal");
  });

  test("rehydrates armed state after restart and clears it on fresh user input", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-restart-"));
    const sessionId = "scan-runtime-restart-1";
    const runtime = createRuntime(workspace);

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-${turn}`,
        toolName: "read",
        args: { file_path: `src/restart-${turn}.ts` },
        outputText: "content",
      });
      runtime.context.onTurnEnd(sessionId);
    }

    const reloaded = createRuntime(workspace);
    const blockedAfterRestart = reloaded.tools.start({
      sessionId,
      toolCallId: "tc-after-restart",
      toolName: "look_at",
      args: { goal: "inspect runtime" },
    });
    expect(blockedAfterRestart.allowed).toBe(false);

    reloaded.context.onUserInput(sessionId);
    reloaded.context.onTurnStart(sessionId, 4);
    const allowedAfterInput = reloaded.tools.start({
      sessionId,
      toolCallId: "tc-after-input",
      toolName: "read",
      args: { file_path: "src/fresh.ts" },
    });
    expect(allowedAfterInput.allowed).toBe(true);

    const reset = reloaded.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset?.payload?.reason).toBe("input_reset");
    expect(
      reloaded.task
        .getState(sessionId)
        .blockers.find((entry) => entry.id === "guard:scan-convergence"),
    ).toBeUndefined();
  });

  test("successful evidence reuse resets the guard inside the same request", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-reset-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-reset-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-${turn}`,
        toolName: "read",
        args: { file_path: `src/reset-${turn}.ts` },
      });
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 4);
    const evidenceReuse = startAndFinishTool({
      runtime,
      sessionId,
      toolCallId: "tc-output-search",
      toolName: "output_search",
      args: { query: "runtime facade" },
      outputText: "found prior evidence",
    });
    expect(evidenceReuse.allowed).toBe(true);

    const rawScan = runtime.tools.start({
      sessionId,
      toolCallId: "tc-read-after-reset",
      toolName: "read",
      args: { file_path: "src/after-reset.ts" },
    });
    expect(rawScan.allowed).toBe(true);

    const reset = runtime.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset?.payload?.reason).toBe("strategy_shift");
    expect(reset?.payload?.toolStrategy).toBe("evidence_reuse");
  });
});
