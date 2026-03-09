import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, parseScheduleIntentEvent } from "@brewva/brewva-runtime";
import {
  createCostViewTool,
  createObsQueryTool,
  createObsSloAssertTool,
  createObsSnapshotTool,
  createOutputSearchTool,
  createRollbackLastPatchTool,
  createScheduleIntentTool,
  createSessionCompactTool,
  createSkillChainControlTool,
  createSkillCompleteTool,
  createSkillLoadTool,
  createTapeTools,
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

    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS 3 tests",
      channelSuccess: true,
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
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
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
    runtime.tools.markCall(sessionId, "edit");

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
    expect((completed.details as { verdict?: string } | undefined)?.verdict).toBe("inconclusive");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("patching");
  });
});

describe("S-009 rollback tool flow", () => {
  test("rollback_last_patch restores tracked edits", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-rollback-tool-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/example.ts"), "export const n = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s9";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "tc-write",
      toolName: "edit",
      args: { file_path: "src/example.ts" },
    });
    writeFileSync(join(workspace, "src/example.ts"), "export const n = 2;\n", "utf8");
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "tc-write",
      toolName: "edit",
      channelSuccess: true,
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
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "read");
    runtime.cost.recordAssistantUsage({
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

describe("S-010a observability tools flow", () => {
  test("obs_query persists a raw artifact and returns a compact summary", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-obs-query-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s10-obs-query";

    runtime.events.record({
      sessionId,
      type: "latency_sample",
      payload: {
        service: "api",
        latencyMs: 810,
      },
    });
    runtime.events.record({
      sessionId,
      type: "latency_sample",
      payload: {
        service: "api",
        latencyMs: 790,
      },
    });

    const tool = createObsQueryTool({ runtime });
    const result = await tool.execute(
      "tc-obs-query",
      {
        types: ["latency_sample"],
        where: { service: "api" },
        metric: "latencyMs",
        aggregation: "p95",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result);
    expect(text.includes("[ObsQuery]")).toBe(true);
    expect(text.includes("query_ref:")).toBe(true);
    expect(text.includes("observed_value:")).toBe(true);

    const artifactOverride = (result.details as { artifactOverride?: { artifactRef?: string } })
      ?.artifactOverride;
    expect(typeof artifactOverride?.artifactRef).toBe("string");
    expect(
      readFileSync(join(workspace, artifactOverride?.artifactRef ?? ""), "utf8").includes(
        '"schema": "brewva.observability.query.v1"',
      ),
    ).toBe(true);
  });

  test("obs_slo_assert returns fail verdict and obs_snapshot exposes runtime health", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-obs-snapshot-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s10-obs-snapshot";

    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 920,
      },
    });

    const assertTool = createObsSloAssertTool({ runtime });
    const assertResult = await assertTool.execute(
      "tc-obs-assert",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
        operator: "<=",
        threshold: 800,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const assertText = extractTextContent(assertResult);
    expect(assertText.includes("verdict: fail")).toBe(true);

    const snapshotTool = createObsSnapshotTool({ runtime });
    const snapshotResult = await snapshotTool.execute(
      "tc-obs-snapshot",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const snapshotText = extractTextContent(snapshotResult);
    expect(snapshotText.includes("[ObsSnapshot]")).toBe(true);
    expect(snapshotText.includes("tape_pressure:")).toBe(true);
    expect(snapshotText.includes("context_pressure:")).toBe(true);
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
    expect(capturedInstructions).toBe(runtime.context.getCompactionInstructions());
  });
});

describe("S-012 tape tools flow", () => {
  test("tape_handoff writes anchor and tape_info reports tape/context pressure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-info-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.task.setSpec(sessionId, {
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
    expect(runtime.events.query(sessionId, { type: "anchor" }).length).toBe(1);

    runtime.events.record({
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 2,
        throttleLevel: "normal",
        cacheHits: 3,
        cacheMisses: 1,
        blocked: false,
        matchLayers: { q1: "exact" },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 0,
        throttleLevel: "limited",
        cacheHits: 1,
        cacheMisses: 2,
        blocked: false,
        matchLayers: { q2: "none" },
      } as Record<string, unknown>,
    });

    const infoResult = await tapeInfo!.execute("tc-info", {}, undefined, undefined, {
      ...fakeContext(sessionId),
      getContextUsage: () => ({ tokens: 880, contextWindow: 1000, percent: 0.88 }),
    });
    const infoText = extractTextContent(infoResult);
    expect(infoText.includes("[TapeInfo]")).toBe(true);
    expect(infoText.includes("tape_pressure:")).toBe(true);
    expect(infoText.includes("context_pressure: high")).toBe(true);
    expect(infoText.includes("output_search_recent_calls: 2")).toBe(true);
    expect(infoText.includes("output_search_throttled_calls: 1")).toBe(true);
    expect(infoText.includes("output_search_cache_hit_rate: 57.1%")).toBe(true);
    expect(infoText.includes("output_search_match_layers: exact=1 partial=0 fuzzy=0 none=1")).toBe(
      true,
    );
  });

  test("tape_search returns matching entries in current phase", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-search";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.events.recordTapeHandoff(sessionId, {
      name: "investigation",
      summary: "Collected flaky test evidence.",
      nextSteps: "Implement fix.",
    });
    runtime.events.record({
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

describe("S-015 skill chain control tool flow", () => {
  test("skill_chain_control supports status/start/pause/resume/cancel", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "s15";
    const tool = createSkillChainControlTool({ runtime });

    const before = await tool.execute(
      "tc-s15-status-before",
      { action: "status" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(
      extractTextContent(before).includes("No active or historical skill cascade intent"),
    ).toBe(true);

    const started = await tool.execute(
      "tc-s15-start",
      {
        action: "start",
        steps: [{ skill: "exploration", consumes: [], produces: ["architecture_map"] }],
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(started).includes("# Skill Cascade")).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)?.source).toBe("explicit");

    const paused = await tool.execute(
      "tc-s15-pause",
      { action: "pause", reason: "manual pause for review" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(paused).includes("status: paused")).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)?.status).toBe("paused");

    const resumed = await tool.execute(
      "tc-s15-resume",
      { action: "resume", reason: "continue execution" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(resumed).includes("# Skill Cascade")).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)?.status).toBe("running");

    const cancelled = await tool.execute(
      "tc-s15-cancel",
      { action: "cancel", reason: "manual stop" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(cancelled).includes("status: cancelled")).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)?.status).toBe("cancelled");
  });
});

describe("S-012b output search tool flow", () => {
  test("output_search finds snippets from persisted artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-a/100-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-a");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "build started",
      "WARN network jitter detected",
      "ERROR connection refused to postgres at 127.0.0.1:5432",
      "retry 3/3 failed",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search",
      {
        query: "connection refused postgres",
        limit: 1,
      },
      undefined,
      undefined,
      {
        ...fakeContext(sessionId),
        cwd: workspace,
      },
    );

    const text = extractTextContent(result);
    expect(text.includes("[OutputSearch]")).toBe(true);
    expect(text.toLowerCase().includes("connection refused")).toBe(true);
    expect(text.includes("tool=exec")).toBe(true);
    expect(
      text.includes("ref=.orchestrator/tool-output-artifacts/session-a/100-exec-call.txt"),
    ).toBe(true);
  });

  test("output_search falls back to fuzzy matching for typo queries", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-fuzzy-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-fuzzy";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-b/101-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-b");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "pipeline bootstrap complete",
      "authentication middleware initialized",
      "token exchange validated",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search-fuzzy",
      {
        query: "authentcation",
        limit: 2,
      },
      undefined,
      undefined,
      {
        ...fakeContext(sessionId),
        cwd: workspace,
      },
    );

    const text = extractTextContent(result);
    expect(text.includes("[OutputSearch]")).toBe(true);
    expect(text.includes("Match layer: fuzzy")).toBe(true);
    expect(text.toLowerCase().includes("authentication middleware")).toBe(true);
  });

  test("output_search suppresses low-confidence fuzzy matches", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-fuzzy-gate-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-fuzzy-gate";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-g/101-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-g");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "pipeline bootstrap complete",
      "authentication middleware initialized",
      "token exchange validated",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search-fuzzy-gate",
      {
        query: "authentxxation",
        limit: 2,
      },
      undefined,
      undefined,
      {
        ...fakeContext(sessionId),
        cwd: workspace,
      },
    );

    const text = extractTextContent(result);
    expect(text.includes("[OutputSearch]")).toBe(true);
    expect(text.includes("No matches found across exact/partial/fuzzy layers.")).toBe(true);
  });

  test("output_search throttles repeated single-query calls", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-throttle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-throttle";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-c");
    mkdirSync(artifactDir, { recursive: true });

    const artifacts = [
      {
        ref: ".orchestrator/tool-output-artifacts/session-c/201-exec-call.txt",
        text: "ERROR timeout while connecting to gateway",
      },
      {
        ref: ".orchestrator/tool-output-artifacts/session-c/202-exec-call.txt",
        text: "timeout retry budget exhausted on upstream",
      },
    ];

    for (const artifact of artifacts) {
      writeFileSync(join(workspace, artifact.ref), artifact.text, "utf8");
      runtime.events.record({
        sessionId,
        type: "tool_output_artifact_persisted",
        payload: {
          toolName: "exec",
          artifactRef: artifact.ref,
          rawBytes: Buffer.byteLength(artifact.text, "utf8"),
        } as Record<string, unknown>,
      });
    }

    const tool = createOutputSearchTool({ runtime });
    for (let call = 0; call < 4; call += 1) {
      const result = await tool.execute(
        `tc-output-search-throttle-normal-${call}`,
        { query: "timeout", limit: 2 },
        undefined,
        undefined,
        { ...fakeContext(sessionId), cwd: workspace },
      );
      expect(extractTextContent(result).includes("Throttle: normal")).toBe(true);
    }

    const limited = await tool.execute(
      "tc-output-search-throttle-limited",
      { query: "timeout", limit: 2 },
      undefined,
      undefined,
      { ...fakeContext(sessionId), cwd: workspace },
    );
    const limitedText = extractTextContent(limited);
    expect(limitedText.includes("Throttle: limited")).toBe(true);
    expect(limitedText.includes("Result limit: 1/2")).toBe(true);
    expect(limitedText.includes("[Throttle]")).toBe(true);

    for (let call = 0; call < 5; call += 1) {
      await tool.execute(
        `tc-output-search-throttle-more-${call}`,
        { query: "timeout", limit: 2 },
        undefined,
        undefined,
        { ...fakeContext(sessionId), cwd: workspace },
      );
    }

    const blocked = await tool.execute(
      "tc-output-search-throttle-blocked",
      { query: "timeout", limit: 2 },
      undefined,
      undefined,
      { ...fakeContext(sessionId), cwd: workspace },
    );
    const blockedText = extractTextContent(blocked);
    expect(blockedText.includes("Blocked due to high-frequency single-query search calls.")).toBe(
      true,
    );
    expect((blocked.details as { verdict?: string } | undefined)?.verdict).toBe("inconclusive");
  });

  test("output_search reuses cache and invalidates on artifact change", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-cache-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-cache";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-d/301-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-d");
    mkdirSync(artifactDir, { recursive: true });

    let artifactText = "cache marker alpha";
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const first = await tool.execute(
      "tc-output-search-cache-first",
      { query: "marker alpha", limit: 2 },
      undefined,
      undefined,
      { ...fakeContext(sessionId), cwd: workspace },
    );
    const firstText = extractTextContent(first);
    expect(firstText.includes("cache marker alpha")).toBe(true);
    expect(firstText.includes("Cache hits/misses: 0/1")).toBe(true);

    const second = await tool.execute(
      "tc-output-search-cache-second",
      { query: "marker alpha", limit: 2 },
      undefined,
      undefined,
      { ...fakeContext(sessionId), cwd: workspace },
    );
    const secondText = extractTextContent(second);
    expect(secondText.includes("Cache hits/misses: 1/0")).toBe(true);

    artifactText = "cache marker beta with updated payload";
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const third = await tool.execute(
      "tc-output-search-cache-third",
      { query: "marker beta updated", limit: 2 },
      undefined,
      undefined,
      { ...fakeContext(sessionId), cwd: workspace },
    );
    const thirdText = extractTextContent(third);
    expect(thirdText.includes("cache marker beta with updated payload")).toBe(true);
    expect(thirdText.includes("Cache hits/misses: 0/1")).toBe(true);
  });
});

describe("S-014 schedule intent tool flow", () => {
  test("schedule_intent supports create/list/cancel", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-schedule-intent-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create",
      {
        action: "create",
        reason: "wait for CI",
        delayMs: 120_000,
        continuityMode: "inherit",
        maxRuns: 1,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const createText = extractTextContent(createResult);
    expect(createText.includes("Schedule intent created.")).toBe(true);

    const createdIntents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(createdIntents.length).toBe(1);
    const createdIntentId = createdIntents[0]?.intentId;
    expect(typeof createdIntentId).toBe("string");
    if (!createdIntentId) return;

    const listResult = await tool.execute(
      "tc-schedule-list",
      {
        action: "list",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const listText = extractTextContent(listResult);
    expect(listText.includes("[ScheduleIntents]")).toBe(true);
    expect(listText.includes(createdIntentId)).toBe(true);

    const cancelResult = await tool.execute(
      "tc-schedule-cancel",
      {
        action: "cancel",
        intentId: createdIntentId,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const cancelText = extractTextContent(cancelResult);
    expect(cancelText.includes("Schedule intent cancelled")).toBe(true);

    const events = runtime.events.query(sessionId, { type: "schedule_intent" });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_created");
    expect(kinds).toContain("intent_cancelled");
  });

  test("schedule_intent create accepts structured convergenceCondition", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-schedule-intent-predicate-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14-predicate";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-predicate",
      {
        action: "create",
        reason: "wait for task done phase",
        delayMs: 120_000,
        convergenceCondition: {
          kind: "task_phase",
          phase: "done",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const createText = extractTextContent(createResult);
    expect(createText.includes("Schedule intent created.")).toBe(true);

    const intents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.convergenceCondition).toEqual({
      kind: "task_phase",
      phase: "done",
    });
  });

  test("schedule_intent create supports cron targets", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-schedule-intent-cron-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14-cron";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-cron",
      {
        action: "create",
        reason: "daily review",
        cron: "*/10 * * * *",
        timeZone: "Asia/Shanghai",
        maxRuns: 4,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const createText = extractTextContent(createResult);
    expect(createText.includes("Schedule intent created.")).toBe(true);
    expect(createText.includes("cron: */10 * * * *")).toBe(true);
    expect(createText.includes("timeZone: Asia/Shanghai")).toBe(true);

    const intents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.cron).toBe("*/10 * * * *");
    expect(intents[0]?.timeZone).toBe("Asia/Shanghai");
    expect(intents[0]?.runAt).toBeUndefined();
    expect(typeof intents[0]?.nextRunAt).toBe("number");
  });

  test("schedule_intent supports update action", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-schedule-intent-update-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14-update";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-for-update",
      {
        action: "create",
        reason: "wait for CI",
        delayMs: 120_000,
        maxRuns: 5,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const createText = extractTextContent(createResult);
    expect(createText.includes("Schedule intent created.")).toBe(true);

    const createdIntents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(createdIntents.length).toBe(1);
    const intentId = createdIntents[0]?.intentId;
    if (!intentId) return;

    const updateResult = await tool.execute(
      "tc-schedule-update",
      {
        action: "update",
        intentId,
        reason: "switch to recurring monitor",
        cron: "*/15 * * * *",
        timeZone: "Asia/Shanghai",
        maxRuns: 8,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const updateText = extractTextContent(updateResult);
    expect(updateText.includes("Schedule intent updated.")).toBe(true);
    expect(updateText.includes("cron: */15 * * * *")).toBe(true);
    expect(updateText.includes("timeZone: Asia/Shanghai")).toBe(true);

    const intents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.cron).toBe("*/15 * * * *");
    expect(intents[0]?.timeZone).toBe("Asia/Shanghai");
    expect(intents[0]?.maxRuns).toBe(8);
    expect(intents[0]?.runAt).toBeUndefined();

    const events = runtime.events.query(sessionId, { type: "schedule_intent" });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_updated");
  });

  test("schedule_intent update rejects blank reason/goalRef", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-schedule-intent-update-blank-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14-update-blank";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-for-update-blank",
      {
        action: "create",
        reason: "initial",
        delayMs: 120_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult).includes("Schedule intent created.")).toBe(true);

    const createdIntents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    const intentId = createdIntents[0]?.intentId;
    if (!intentId) return;

    const blankReasonResult = await tool.execute(
      "tc-schedule-update-blank-reason",
      {
        action: "update",
        intentId,
        reason: "   ",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(
      extractTextContent(blankReasonResult).includes(
        "Schedule intent update rejected (invalid_reason).",
      ),
    ).toBe(true);
    expect((blankReasonResult.details as { verdict?: string } | undefined)?.verdict).toBe("fail");

    const blankGoalRefResult = await tool.execute(
      "tc-schedule-update-blank-goal-ref",
      {
        action: "update",
        intentId,
        goalRef: "   ",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(
      extractTextContent(blankGoalRefResult).includes(
        "Schedule intent update rejected (invalid_goal_ref).",
      ),
    ).toBe(true);
    expect((blankGoalRefResult.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("schedule_intent update supports timezone-only patch for cron intent", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "brewva-schedule-intent-update-timezone-only-tool-"),
    );
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14-update-timezone-only";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-for-update-timezone-only",
      {
        action: "create",
        reason: "daily monitor",
        cron: "0 9 * * *",
        timeZone: "Asia/Shanghai",
        maxRuns: 5,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult).includes("Schedule intent created.")).toBe(true);

    const createdIntents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    const intentId = createdIntents[0]?.intentId;
    if (!intentId) return;

    const updateResult = await tool.execute(
      "tc-schedule-update-timezone-only",
      {
        action: "update",
        intentId,
        timeZone: "America/New_York",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const updateText = extractTextContent(updateResult);
    expect(updateText.includes("Schedule intent updated.")).toBe(true);
    expect(updateText.includes("cron: 0 9 * * *")).toBe(true);
    expect(updateText.includes("timeZone: America/New_York")).toBe(true);

    const intents = await runtime.schedule.listIntents({ parentSessionId: sessionId });
    expect(intents.length).toBe(1);
    expect(intents[0]?.cron).toBe("0 9 * * *");
    expect(intents[0]?.timeZone).toBe("America/New_York");
  });

  test("schedule_intent rejects timeZone without cron", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-schedule-intent-timezone-guard-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s14-timezone-guard";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-create-timezone-guard",
      {
        action: "create",
        reason: "invalid timezone usage",
        delayMs: 120_000,
        timeZone: "Asia/Shanghai",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const createText = extractTextContent(createResult);
    expect(createText.includes("Schedule intent rejected (timeZone_requires_cron).")).toBe(true);
    expect((createResult.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });
});
