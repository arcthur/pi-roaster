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
    channelSuccess: input.channelSuccess !== false,
    verdict: input.verdict,
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

  test("toc tools are classified as low-signal investigation and arm the guard", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-toc-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-toc-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 6; turn += 1) {
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

    runtime.context.onTurnStart(sessionId, 7);
    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-toc-search-blocked",
      toolName: "toc_search",
      args: { query: "runtime facade" },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("Stop low-signal investigation")).toBe(true);

    const blockedEvent = runtime.events.query(sessionId, {
      type: "scan_convergence_blocked_tool",
      last: 1,
    })[0];
    expect(blockedEvent?.payload?.toolStrategy).toBe("low_signal");
  });

  test("obs_query is classified as evidence reuse and clears the guard", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-obs-query-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-obs-query-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-obs-${turn}`,
        toolName: "read",
        args: { file_path: `src/obs-${turn}.ts` },
      });
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 4);
    const evidenceReuse = startAndFinishTool({
      runtime,
      sessionId,
      toolCallId: "tc-obs-query",
      toolName: "obs_query",
      args: { types: ["tool_result_recorded"], metric: "rawTokens", aggregation: "p95" },
      outputText: "[ObsQuery]\nmatch_count: 1",
    });
    expect(evidenceReuse.allowed).toBe(true);

    const rawScan = runtime.tools.start({
      sessionId,
      toolCallId: "tc-read-after-obs-query",
      toolName: "read",
      args: { file_path: "src/after-obs-query.ts" },
    });
    expect(rawScan.allowed).toBe(true);

    const reset = runtime.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset?.payload?.toolStrategy).toBe("evidence_reuse");
  });

  test("non-pass evidence reuse does not clear the guard", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-non-pass-reset-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-non-pass-reset-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-non-pass-${turn}`,
        toolName: "read",
        args: { file_path: `src/non-pass-${turn}.ts` },
      });
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 4);
    const evidenceReuse = startAndFinishTool({
      runtime,
      sessionId,
      toolCallId: "tc-output-search-inconclusive",
      toolName: "output_search",
      args: { query: "runtime facade" },
      outputText: "Search throttled; no stable answer yet.",
      verdict: "inconclusive",
    });
    expect(evidenceReuse.allowed).toBe(true);

    const stillBlocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-read-still-blocked",
      toolName: "read",
      args: { file_path: "src/still-blocked.ts" },
    });
    expect(stillBlocked.allowed).toBe(false);

    const reset = runtime.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset).toBeUndefined();
  });

  test("skill_chain_control status does not clear an armed guard", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-status-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-status-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-status-${turn}`,
        toolName: "read",
        args: { file_path: `src/status-${turn}.ts` },
        outputText: "content",
      });
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 4);
    const status = startAndFinishTool({
      runtime,
      sessionId,
      toolCallId: "tc-skill-chain-status",
      toolName: "skill_chain_control",
      args: { action: "status" },
      outputText: "# Skill Cascade\n- status: pending",
    });
    expect(status.allowed).toBe(true);

    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-read-after-status",
      toolName: "read",
      args: { file_path: "src/still-blocked.ts" },
    });
    expect(blocked.allowed).toBe(false);

    const reset = runtime.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset).toBeUndefined();
  });

  test("skill_chain_control start clears the guard as a strategy shift", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-scan-runtime-start-"));
    const runtime = createRuntime(workspace);
    const sessionId = "scan-runtime-start-1";

    runtime.context.onUserInput(sessionId);

    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.context.onTurnStart(sessionId, turn);
      startAndFinishTool({
        runtime,
        sessionId,
        toolCallId: `tc-read-start-${turn}`,
        toolName: "read",
        args: { file_path: `src/start-${turn}.ts` },
        outputText: "content",
      });
      runtime.context.onTurnEnd(sessionId);
    }

    runtime.context.onTurnStart(sessionId, 4);
    const started = startAndFinishTool({
      runtime,
      sessionId,
      toolCallId: "tc-skill-chain-start",
      toolName: "skill_chain_control",
      args: {
        action: "start",
        steps: [{ skill: "repository-analysis", produces: ["repository_snapshot"] }],
      },
      outputText: "# Skill Cascade\n- status: pending",
    });
    expect(started.allowed).toBe(true);

    const rawScan = runtime.tools.start({
      sessionId,
      toolCallId: "tc-read-after-start",
      toolName: "read",
      args: { file_path: "src/after-start.ts" },
    });
    expect(rawScan.allowed).toBe(true);

    const reset = runtime.events.query(sessionId, {
      type: "scan_convergence_reset",
      last: 1,
    })[0];
    expect(reset?.payload?.reason).toBe("strategy_shift");
    expect(reset?.payload?.toolStrategy).toBe("progress");
  });
});
