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
  channelSuccess?: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  outputText?: string;
}): { allowed: boolean; reason?: string; advisory?: string; posture?: string } {
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
    channelSuccess: input.channelSuccess !== false,
    verdict: input.verdict,
  });
  return started;
}

describe("scan convergence service", () => {
  test("arms after repeated scan-only turns and advises subsequent observe tools instead of blocking", () => {
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

    expect(
      runtime.task
        .getState(sessionId)
        .blockers.find((entry) => entry.id === "guard:scan-convergence"),
    ).toBeUndefined();

    runtime.context.onTurnStart(sessionId, 4);
    const advised = runtime.tools.start({
      sessionId,
      toolCallId: "tc-look-at-advised",
      toolName: "look_at",
      args: { goal: "find the runtime facade" },
    });
    expect(advised.allowed).toBe(true);
    expect(advised.advisory).toContain("[ExplorationAdvisory]");
    expect(advised.posture).toBe("observe");

    const advisoryEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_advisory",
      last: 1,
    })[0];
    expect(advisoryEvent?.payload?.toolStrategy).toBe("low_signal");
  });

  test("rehydrates armed advisory state after restart and clears it on fresh user input", () => {
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
    const advisedAfterRestart = reloaded.tools.start({
      sessionId,
      toolCallId: "tc-after-restart",
      toolName: "look_at",
      args: { goal: "inspect runtime" },
    });
    expect(advisedAfterRestart.allowed).toBe(true);
    expect(advisedAfterRestart.advisory).toContain("[ExplorationAdvisory]");

    reloaded.context.onUserInput(sessionId);
    reloaded.context.onTurnStart(sessionId, 4);
    const allowedAfterInput = reloaded.tools.start({
      sessionId,
      toolCallId: "tc-after-input",
      toolName: "read",
      args: { file_path: "src/fresh.ts" },
    });
    expect(allowedAfterInput.allowed).toBe(true);
    expect(allowedAfterInput.advisory).toBeUndefined();

    const reset = reloaded.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset?.payload?.reason).toBe("input_reset");
  });

  test("task mutations still clear an armed advisory as a strategy shift", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-progress-reset-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-progress-reset-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-progress-${turn}`,
        toolName: "read",
        args: { file_path: `src/progress-${turn}.ts` },
      });
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 4);
    const progress = startAndFinishTool({
      runtime,
      sessionId,
      toolCallId: "tc-task-record-blocker",
      toolName: "task_record_blocker",
      args: {
        message: "Need a concrete owning module before more scanning",
      },
      outputText: "Blocker recorded.",
    });
    expect(progress.allowed).toBe(true);

    const rawScan = runtime.tools.start({
      sessionId,
      toolCallId: "tc-read-after-progress",
      toolName: "read",
      args: { file_path: "src/after-progress.ts" },
    });
    expect(rawScan.allowed).toBe(true);
    expect(rawScan.advisory).toBeUndefined();

    const reset = runtime.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset?.payload?.reason).toBe("strategy_shift");
    expect(reset?.payload?.toolStrategy).toBe("progress");
  });

  test("toc_document arms the advisory path after repeated low-signal investigation turns", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-toc-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-toc-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 8; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      const started = startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-toc-${turn}`,
        toolName: "toc_document",
        args: { filePath: `src/file-${turn}.ts` },
        outputText: "[TOCDocument]",
      });
      expect(started.allowed).toBe(true);
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 9);
    const advised = runtime.tools.start({
      sessionId,
      toolCallId: "tc-toc-search-advised",
      toolName: "toc_search",
      args: { query: "runtime facade" },
    });
    expect(advised.allowed).toBe(true);
    expect(advised.advisory).toContain("[ExplorationAdvisory]");

    const armedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_armed",
      last: 1,
    })[0];
    expect(armedEvent?.payload?.reason).toBe("investigation_only_turns");
  });
});
