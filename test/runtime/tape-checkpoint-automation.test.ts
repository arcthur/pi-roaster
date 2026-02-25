import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  TAPE_CHECKPOINT_EVENT_TYPE,
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
