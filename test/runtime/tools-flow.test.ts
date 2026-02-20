import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import {
  createCostViewTool,
  createRollbackLastPatchTool,
  createSessionCompactTool,
  createSkillCompleteTool,
  createSkillLoadTool,
  createTapeTools,
  createTaskLedgerTools,
} from "@brewva/brewva-tools";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

describe("S-008 patching e2e loop", () => {
  test("skill_load -> edit -> verify -> skill_complete", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "s8";

    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    const loaded = await loadTool.execute(
      "tc-1",
      { name: "patching" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const loadedText = extractTextContent(loaded);
    expect(loadedText.includes("Skill Loaded: patching")).toBe(true);

    runtime.markToolCall(sessionId, "edit");
    runtime.recordToolResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      success: true,
    });
    runtime.recordToolResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS 3 tests",
      success: true,
    });

    const completed = await completeTool.execute(
      "tc-2",
      {
        outputs: {
          change_summary: "updated one line",
          files_changed: ["src/example.ts"],
          verification: "pass",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const completedText = extractTextContent(completed);
    expect(completedText.includes("verification gate passed")).toBe(true);
    expect(runtime.getActiveSkill(sessionId)).toBeUndefined();
  });

  test("skill_complete keeps skill active when verification is blocked", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "s8-blocked";

    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-1",
      { name: "patching" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    runtime.markToolCall(sessionId, "edit");

    const completed = await completeTool.execute(
      "tc-2",
      {
        outputs: {
          change_summary: "updated one line",
          files_changed: ["src/example.ts"],
          verification: "pass",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const completedText = extractTextContent(completed);
    expect(completedText.includes("Verification gate blocked")).toBe(true);
    expect(runtime.getActiveSkill(sessionId)?.name).toBe("patching");
  });
});

describe("S-009 rollback tool flow", () => {
  test("rollback_last_patch restores tracked edits", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-tool-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/example.ts"), "export const n = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s9";
    runtime.onTurnStart(sessionId, 1);

    runtime.trackToolCallStart({
      sessionId,
      toolCallId: "tc-write",
      toolName: "edit",
      args: { file_path: "src/example.ts" },
    });
    writeFileSync(join(workspace, "src/example.ts"), "export const n = 2;\n", "utf8");
    runtime.trackToolCallEnd({
      sessionId,
      toolCallId: "tc-write",
      toolName: "edit",
      success: true,
    });

    const rollbackTool = createRollbackLastPatchTool({ runtime });
    const result = await rollbackTool.execute(
      "tc-rollback",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const text = extractTextContent(result);

    expect(text.includes("Rolled back patch set")).toBe(true);
    expect(readFileSync(join(workspace, "src/example.ts"), "utf8")).toBe("export const n = 1;\n");
  });
});

describe("S-010 cost view tool flow", () => {
  test("cost_view returns session/skill/tool breakdown", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "s10";
    runtime.onTurnStart(sessionId, 1);
    runtime.markToolCall(sessionId, "read");
    runtime.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.001,
    });

    const tool = createCostViewTool({ runtime });
    const result = await tool.execute(
      "tc-cost",
      { top: 3 },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const text = extractTextContent(result);
    expect(text.includes("# Cost View")).toBe(true);
    expect(text.includes("Top Skills")).toBe(true);
    expect(text.includes("Top Tools")).toBe(true);
  });
});

describe("S-011 session compact tool flow", () => {
  test("session_compact requests SDK compaction with runtime instructions", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "s11";
    let compactCalls = 0;
    let capturedInstructions: string | undefined;

    const tool = createSessionCompactTool({ runtime });
    const result = await tool.execute(
      "tc-compact",
      { reason: "context pressure reached high" },
      undefined,
      undefined,
      {
        ...fakeContext(sessionId),
        compact: (options?: { customInstructions?: string }) => {
          compactCalls += 1;
          capturedInstructions = options?.customInstructions;
        },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 0.9 }),
      },
    );

    const text = extractTextContent(result);
    expect(text.includes("Session compaction requested")).toBe(true);
    expect(compactCalls).toBe(1);
    expect(capturedInstructions).toBe(runtime.getCompactionInstructions());
  });
});

describe("S-012 tape tools flow", () => {
  test("tape_handoff writes anchor and tape_info reports tape/context pressure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-info-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12";
    runtime.onTurnStart(sessionId, 1);

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "validate tape tools",
    });

    const tools = createTapeTools({ runtime });
    const tapeHandoff = tools.find((tool) => tool.name === "tape_handoff");
    const tapeInfo = tools.find((tool) => tool.name === "tape_info");
    expect(tapeHandoff).toBeDefined();
    expect(tapeInfo).toBeDefined();

    const handoffResult = await tapeHandoff!.execute(
      "tc-handoff",
      {
        name: "investigation-done",
        summary: "Findings captured.",
        next_steps: "Start implementation.",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const handoffText = extractTextContent(handoffResult);
    expect(handoffText.includes("Tape handoff recorded")).toBe(true);
    expect(runtime.queryEvents(sessionId, { type: "anchor" }).length).toBe(1);

    const infoResult = await tapeInfo!.execute("tc-info", {}, undefined, undefined, {
      ...fakeContext(sessionId),
      getContextUsage: () => ({ tokens: 880, contextWindow: 1000, percent: 0.88 }),
    });
    const infoText = extractTextContent(infoResult);
    expect(infoText.includes("[TapeInfo]")).toBe(true);
    expect(infoText.includes("tape_pressure:")).toBe(true);
    expect(infoText.includes("context_pressure: high")).toBe(true);
  });

  test("tape_search returns matching entries in current phase", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-search";
    runtime.onTurnStart(sessionId, 1);

    runtime.recordTapeHandoff(sessionId, {
      name: "investigation",
      summary: "Collected flaky test evidence.",
      nextSteps: "Implement fix.",
    });
    runtime.recordEvent({
      sessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: { id: "i1", text: "Fix flaky pipeline", status: "todo" },
      } as Record<string, unknown>,
    });

    const tools = createTapeTools({ runtime });
    const tapeSearch = tools.find((tool) => tool.name === "tape_search");
    expect(tapeSearch).toBeDefined();

    const result = await tapeSearch!.execute(
      "tc-search",
      { query: "flaky", scope: "current_phase" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result);
    expect(text.includes("[TapeSearch]")).toBe(true);
    expect(text.includes("matches:")).toBe(true);
    expect(text.toLowerCase().includes("flaky")).toBe(true);
  });
});

describe("S-013 memory insight tool flow", () => {
  test("memory_dismiss_insight dismisses open insights", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-dismiss-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s13";

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Dismiss noisy insight",
    });
    runtime.recordTaskBlocker(sessionId, {
      message: "verification may fail because fixtures are missing",
      source: "test",
    });
    runtime.recordTaskBlocker(sessionId, {
      message: "verification may fail because network is flaky",
      source: "test",
    });
    runtime.buildContextInjection(sessionId, "continue implementation");

    const insightsPath = join(workspace, ".orchestrator/memory/insights.jsonl");
    const insightRows = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const latestById = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of insightRows) {
      const existing = latestById.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        latestById.set(row.id, row);
      }
    }
    const openInsight = [...latestById.values()].find((row) => row.status === "open");
    expect(openInsight).toBeDefined();
    if (!openInsight) return;

    const tools = createTaskLedgerTools({ runtime });
    const dismissTool = tools.find((tool) => tool.name === "memory_dismiss_insight");
    expect(dismissTool).toBeDefined();
    if (!dismissTool) return;

    const result = await dismissTool.execute(
      "tc-memory-dismiss",
      { insightId: openInsight.id },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const text = extractTextContent(result);
    expect(text.includes("Insight dismissed.")).toBe(true);
  });

  test("memory_review_evolves_edge reviews proposed edges", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-review-edge-tool-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.evolvesMode = "shadow";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "s13e";

    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use sqlite for current task.",
    });
    runtime.setTaskSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use postgres instead of sqlite for current task.",
    });
    runtime.buildContextInjection(sessionId, "continue implementation");

    const evolvesPath = join(workspace, ".orchestrator/memory/evolves.jsonl");
    const rows = readFileSync(evolvesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const latestById = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of rows) {
      const existing = latestById.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        latestById.set(row.id, row);
      }
    }
    const proposed = [...latestById.values()].find((edge) => edge.status === "proposed");
    expect(proposed).toBeDefined();
    if (!proposed) return;

    const tools = createTaskLedgerTools({ runtime });
    const reviewTool = tools.find((tool) => tool.name === "memory_review_evolves_edge");
    expect(reviewTool).toBeDefined();
    if (!reviewTool) return;

    const result = await reviewTool.execute(
      "tc-memory-review-edge",
      { edgeId: proposed.id, decision: "accept" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const text = extractTextContent(result);
    expect(text.includes("Evolves edge reviewed.")).toBe(true);

    const afterRows = readFileSync(evolvesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const afterLatest = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of afterRows) {
      const existing = afterLatest.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        afterLatest.set(row.id, row);
      }
    }
    expect(afterLatest.get(proposed.id)?.status).toBe("accepted");
  });
});
