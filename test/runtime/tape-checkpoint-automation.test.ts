import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeCheckpointPayload,
} from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

interface EvolveRow {
  id: string;
  status: string;
  targetUnitId?: string;
  updatedAt: number;
}

function readLatestEvolvesRows(filePath: string): Map<string, EvolveRow> {
  const rows = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvolveRow);
  const latestById = new Map<string, EvolveRow>();
  for (const row of rows) {
    const current = latestById.get(row.id);
    if (!current || row.updatedAt >= current.updatedAt) {
      latestById.set(row.id, row);
    }
  }
  return latestById;
}

describe("tape checkpoint automation", () => {
  test("uses session-local checkpoint counters instead of per-event tape rescans", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-counter-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 1000;
    const sessionId = "tape-counter-1";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });

    const runtimePrivate = runtime as unknown as {
      eventStore: {
        list: (sessionId: string, query?: Record<string, unknown>) => unknown[];
      };
    };
    const originalList = runtimePrivate.eventStore.list.bind(runtimePrivate.eventStore);
    let listCalls = 0;
    runtimePrivate.eventStore.list = (targetSessionId: string, query?: Record<string, unknown>) => {
      listCalls += 1;
      return originalList(targetSessionId, query);
    };

    for (let index = 0; index < 24; index += 1) {
      runtime.events.record({
        sessionId,
        type: "tool_call",
        payload: {
          toolCallId: `tc-${index}`,
          toolName: "look_at",
        },
      });
    }

    expect(listCalls).toBe(1);
    const checkpoints = originalList(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE });
    expect(checkpoints).toHaveLength(0);
    runtimePrivate.eventStore.list = originalList;
  });

  test("writes checkpoint events by interval and replays consistent state after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-checkpoint-"));
    const sessionId = "tape-checkpoint-1";
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 3;

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "checkpoint consistency",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth-1",
      kind: "test",
      severity: "warn",
      summary: "first fact",
    });
    runtime.task.addItem(sessionId, { text: "item-1", status: "todo" });
    runtime.task.addItem(sessionId, { text: "item-2", status: "doing" });

    const checkpoints = runtime.events.query(sessionId, {
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const checkpointPayload = (checkpoints.at(-1)?.payload ?? {}) as {
      schema?: string;
      state?: {
        task?: { items?: Array<{ text?: string }> };
        truth?: { facts?: Array<{ id?: string }> };
      };
    };
    expect(checkpointPayload.schema).toBe("brewva.tape.checkpoint.v1");
    expect(checkpointPayload.state?.task?.items?.some((item) => item.text === "item-1")).toBe(true);
    expect(checkpointPayload.state?.truth?.facts?.some((fact) => fact.id === "truth-1")).toBe(true);

    runtime.truth.upsertFact(sessionId, {
      id: "truth-2",
      kind: "test",
      severity: "error",
      summary: "second fact",
    });
    runtime.task.addItem(sessionId, { text: "item-3", status: "todo" });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    const taskState = reloaded.task.getState(sessionId);
    const truthState = reloaded.truth.getState(sessionId);
    expect(taskState.items.map((item) => item.text)).toEqual(["item-1", "item-2", "item-3"]);
    expect(truthState.facts.some((fact) => fact.id === "truth-1")).toBe(true);
    expect(truthState.facts.some((fact) => fact.id === "truth-2")).toBe(true);
  });

  test("rehydrates active skill and tool-call budget state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-budget-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 0;
    config.security.mode = "strict";
    config.skills.roots = [join(repoRoot(), "skills")];
    const sessionId = "budget-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    const activated = runtime.skills.activate(sessionId, "exploration");
    expect(activated.ok).toBe(true);
    const maxToolCalls = activated.skill?.contract.budget.maxToolCalls ?? 0;
    const consumed = Math.max(1, maxToolCalls);
    for (let index = 0; index < consumed; index += 1) {
      runtime.tools.markCall(sessionId, "look_at");
    }
    const blockedBeforeRestart = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blockedBeforeRestart.allowed).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const blockedAfterRestart = reloaded.tools.checkAccess(sessionId, "look_at");
    expect(blockedAfterRestart.allowed).toBe(false);
    expect(blockedAfterRestart.reason?.includes("maxToolCalls")).toBe(true);
  });

  test("rehydrates session cost budget state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cost-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.costTracking.actionOnExceed = "block_tools";
    config.infrastructure.costTracking.maxCostUsdPerSession = 0.001;
    const sessionId = "cost-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.002,
    });

    const blockedBeforeRestart = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blockedBeforeRestart.allowed).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const blockedAfterRestart = reloaded.tools.checkAccess(sessionId, "look_at");
    expect(blockedAfterRestart.allowed).toBe(false);
    expect(blockedAfterRestart.reason?.includes("Session cost exceeded")).toBe(true);
  });

  test("resets checkpoint counter state when a checkpoint is manually recorded", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-manual-checkpoint-counter-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 3;
    const sessionId = "manual-checkpoint-counter-1";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });

    const recordSyntheticEvent = (index: number): void => {
      runtime.events.record({
        sessionId,
        type: "tool_call",
        payload: {
          toolCallId: `manual-tc-${index}`,
          toolName: "look_at",
        },
      });
    };

    recordSyntheticEvent(1);
    recordSyntheticEvent(2);
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(0);

    const replay = (
      runtime as unknown as {
        turnReplay: {
          getCheckpointEvidenceState: (sessionId: string) => unknown;
          getCheckpointMemoryState: (sessionId: string) => unknown;
        };
      }
    ).turnReplay;

    const payload = buildTapeCheckpointPayload({
      taskState: runtime.task.getState(sessionId),
      truthState: runtime.truth.getState(sessionId),
      costSummary: runtime.cost.getSummary(sessionId),
      evidenceState: replay.getCheckpointEvidenceState(sessionId) as Parameters<
        typeof buildTapeCheckpointPayload
      >[0]["evidenceState"],
      memoryState: replay.getCheckpointMemoryState(sessionId) as Parameters<
        typeof buildTapeCheckpointPayload
      >[0]["memoryState"],
      reason: "manual_test",
    });
    runtime.events.record({
      sessionId,
      type: TAPE_CHECKPOINT_EVENT_TYPE,
      payload: payload as unknown as Record<string, unknown>,
    });
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(1);

    recordSyntheticEvent(3);
    recordSyntheticEvent(4);
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(1);

    recordSyntheticEvent(5);
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(2);
  });

  test("preserves same-turn tool cost allocation across checkpoint-based restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cost-alloc-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 2;
    const sessionId = "cost-allocation-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "look_at");
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 100,
      costUsd: 0.001,
    });

    const checkpoints = runtime.events.query(sessionId, {
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const beforeRestart = runtime.cost.getSummary(sessionId);
    expect(beforeRestart.tools.look_at?.allocatedTokens).toBe(100);
    expect(beforeRestart.skills["(none)"]?.turns).toBe(1);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    reloaded.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 50,
      costUsd: 0.0005,
    });
    const afterRestart = reloaded.cost.getSummary(sessionId);

    expect(afterRestart.tools.look_at?.callCount).toBe(1);
    expect(afterRestart.tools.look_at?.allocatedTokens).toBe(150);
    expect(afterRestart.totalTokens).toBe(150);
    expect(afterRestart.totalCostUsd).toBeCloseTo(0.0015, 8);
    expect(afterRestart.skills["(none)"]?.turns).toBe(1);
    expect(afterRestart.tools.llm).toBeUndefined();
  });

  test("rehydrates ledger compaction cooldown turn from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ledger-cooldown-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.ledger.checkpointEveryTurns = 1;
    const sessionId = "ledger-cooldown-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-a" },
      outputText: "ok",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-b" },
      outputText: "ok",
      success: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-c" },
      outputText: "ok",
      success: true,
    });
    expect(runtime.events.query(sessionId, { type: "ledger_compacted" })).toHaveLength(1);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    reloaded.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo second" },
      outputText: "ok",
      success: true,
    });
    expect(reloaded.events.query(sessionId, { type: "ledger_compacted" })).toHaveLength(1);
  });

  test("rebuilds memory projection from tape after memory files are removed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-rebuild-"));
    const sessionId = "memory-rebuild-1";

    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Recover memory projection from tape",
      constraints: ["rebuild projection when files are missing"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "projection rebuild validation",
      source: "test",
    });
    const before = await runtime.context.buildInjection(sessionId, "continue");
    expect(before.text.includes("[WorkingMemory]")).toBe(true);

    const memoryDir = join(workspace, ".orchestrator/memory");
    rmSync(join(memoryDir, "units.jsonl"), { force: true });
    rmSync(join(memoryDir, "crystals.jsonl"), { force: true });
    rmSync(join(memoryDir, "insights.jsonl"), { force: true });
    rmSync(join(memoryDir, "evolves.jsonl"), { force: true });
    rmSync(join(memoryDir, "state.json"), { force: true });
    rmSync(join(memoryDir, "working.md"), { force: true });

    const reloaded = new BrewvaRuntime({ cwd: workspace });
    reloaded.context.onTurnStart(sessionId, 2);
    const after = await reloaded.context.buildInjection(sessionId, "continue");
    expect(after.text.includes("[WorkingMemory]")).toBe(true);
    expect(after.text.includes("Recover memory projection from tape")).toBe(true);

    const unitsPath = join(memoryDir, "units.jsonl");
    expect(existsSync(unitsPath)).toBe(true);
    const lines = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("given accepted evolves edge before restart, when runtime rebuilds from tape, then accepted edge status is preserved", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-review-rebuild-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.evolvesMode = "shadow";
    const sessionId = "memory-review-rebuild-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use sqlite for current task.",
    });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Use postgres instead of sqlite for current task.",
    });
    await runtime.context.buildInjection(sessionId, "continue implementation");

    const evolvesPath = join(workspace, ".orchestrator/memory/evolves.jsonl");
    const evolvesLatest = readLatestEvolvesRows(evolvesPath);
    const proposed = [...evolvesLatest.values()].find((edge) => edge.status === "proposed");
    expect(proposed).toBeDefined();
    if (!proposed) return;

    runtime.memory.reviewEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });

    const memoryDir = join(workspace, ".orchestrator/memory");
    rmSync(join(memoryDir, "units.jsonl"), { force: true });
    rmSync(join(memoryDir, "crystals.jsonl"), { force: true });
    rmSync(join(memoryDir, "insights.jsonl"), { force: true });
    rmSync(join(memoryDir, "evolves.jsonl"), { force: true });
    rmSync(join(memoryDir, "state.json"), { force: true });
    rmSync(join(memoryDir, "working.md"), { force: true });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 2);
    await reloaded.context.buildInjection(sessionId, "continue implementation");

    const evolvesLatestAfter = readLatestEvolvesRows(evolvesPath);
    expect(evolvesLatestAfter.get(proposed.id)?.status).toBe("accepted");
  });
});
