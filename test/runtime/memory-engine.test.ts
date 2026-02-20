import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, TASK_EVENT_TYPE, type BrewvaEventRecord } from "@brewva/brewva-runtime";

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function taskSpecEvent(input: {
  id: string;
  sessionId: string;
  goal: string;
  turn?: number;
  timestamp?: number;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TASK_EVENT_TYPE,
    turn: input.turn,
    timestamp,
    payload: {
      schema: "brewva.task.ledger.v1",
      kind: "spec_set",
      spec: {
        schema: "brewva.task.v1",
        goal: input.goal,
      },
    },
  };
}

function taskStatusEvent(input: {
  id: string;
  sessionId: string;
  phase: "align" | "investigate" | "execute" | "verify" | "blocked" | "done";
  health: "ok" | "needs_spec" | "blocked" | "verification_failed" | "budget_pressure" | "unknown";
  reason?: string;
  turn?: number;
  timestamp?: number;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: TASK_EVENT_TYPE,
    turn: input.turn,
    timestamp,
    payload: {
      schema: "brewva.task.ledger.v1",
      kind: "status_set",
      status: {
        phase: input.phase,
        health: input.health,
        reason: input.reason ?? null,
        updatedAt: timestamp,
      },
    },
  };
}

function verificationStateResetEvent(input: {
  id: string;
  sessionId: string;
  turn?: number;
  timestamp?: number;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: "verification_state_reset",
    turn: input.turn,
    timestamp,
    payload: {
      reason: "rollback",
    },
  };
}

function parseJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function latestRowsById<T extends { id: string; updatedAt: number }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(row.id);
    if (!current || row.updatedAt >= current.updatedAt) {
      latest.set(row.id, row);
    }
  }
  return [...latest.values()];
}

describe("memory engine", () => {
  test("publishes working snapshot when dirty events are ingested", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-dirty-"));
    const recorded: string[] = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      recordEvent: (event) => {
        recorded.push(event.type);
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-1",
        sessionId: "memory-engine-session",
        goal: "Ship memory projections with stable context injection.",
      }),
    );

    const snapshot = engine.refreshIfNeeded({
      sessionId: "memory-engine-session",
    });

    expect(snapshot).toBeDefined();
    expect(snapshot?.content.includes("[WorkingMemory]")).toBe(true);
    expect(snapshot?.content.includes("Ship memory projections")).toBe(true);
    expect(recorded).toContain("memory_unit_upserted");
    expect(recorded).toContain("memory_working_published");

    const workingPath = join(workspace, "working.md");
    expect(existsSync(workingPath)).toBe(true);
    const workingContent = readFileSync(workingPath, "utf8");
    expect(workingContent.includes("[WorkingMemory]")).toBe(true);
  });

  test("refreshes by daily trigger once and then reuses published snapshot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-daily-"));
    const previousDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
    writeFileSync(
      join(workspace, "state.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          lastPublishedAt: Date.now() - 24 * 60 * 60 * 1000,
          lastPublishedDayKey: dayKey(previousDay),
          dirtyTopics: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const recorded: string[] = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 0,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      recordEvent: (event) => {
        recorded.push(event.type);
      },
    });

    const first = engine.refreshIfNeeded({
      sessionId: "memory-engine-session",
    });
    const second = engine.refreshIfNeeded({
      sessionId: "memory-engine-session",
    });

    const publishCount = recorded.filter((type) => type === "memory_working_published").length;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(publishCount).toBe(1);
  });

  test("writes proposed evolves edges in shadow mode", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-evolves-"));
    const recorded: string[] = [];
    const sessionId = "memory-engine-evolves-session";
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
      recordEvent: (event) => {
        recorded.push(event.type);
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-old",
        sessionId,
        goal: "Use sqlite for current task.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-new",
        sessionId,
        goal: "Use postgres instead of sqlite for current task.",
        timestamp: Date.now(),
      }),
    );

    const snapshot = engine.refreshIfNeeded({
      sessionId,
    });
    expect(snapshot).toBeDefined();

    const evolvesPath = join(workspace, "evolves.jsonl");
    const edges = parseJsonLines<{ status?: string }>(evolvesPath);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((edge) => edge.status === "proposed")).toBe(true);
    expect(recorded).toContain("memory_insight_recorded");
  });

  test("does not duplicate evolves edges across reloads", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-backfill-"));
    const sessionId = "memory-engine-backfill-session";

    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-old",
        sessionId,
        goal: "Use sqlite for current task.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-new",
        sessionId,
        goal: "Use postgres instead of sqlite for current task.",
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({ sessionId });

    const evolvesPath = join(workspace, "evolves.jsonl");
    const edges = parseJsonLines<{
      sourceUnitId: string;
      targetUnitId: string;
      relation: string;
    }>(evolvesPath);
    const firstEdge = edges[0];
    expect(firstEdge).toBeDefined();
    if (!firstEdge) return;
    expect(edges.length).toBeGreaterThan(0);

    const engineReloaded = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
    });
    engineReloaded.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-trigger-backfill",
        sessionId,
        goal: "Use postgres instead of sqlite for current task.",
        timestamp: Date.now() + 1_000,
      }),
    );
    engineReloaded.refreshIfNeeded({ sessionId });

    const afterEdges = parseJsonLines<{
      sourceUnitId: string;
      targetUnitId: string;
      relation: string;
    }>(evolvesPath);
    expect(afterEdges.length).toBe(edges.length);
    const keys = new Set(
      afterEdges.map((edge) => `${edge.sourceUnitId}:${edge.targetUnitId}:${edge.relation}`),
    );
    expect(keys.size).toBe(afterEdges.length);
  });

  test("classifies explicit replacement phrasing as replaces", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-replaces-"));
    const sessionId = "memory-engine-replaces-session";
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-old",
        sessionId,
        goal: "Use sqlite for current task.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-new",
        sessionId,
        goal: "Switch to postgres instead of sqlite for current task.",
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({ sessionId });

    const edges = latestRowsById(
      parseJsonLines<{ id: string; relation: string; updatedAt: number }>(
        join(workspace, "evolves.jsonl"),
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe("replaces");
  });

  test("avoids false challenge for benign negation phrasing", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-negation-"));
    const sessionId = "memory-engine-negation-session";
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-old",
        sessionId,
        goal: "There is no issue with sqlite migration order.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-new",
        sessionId,
        goal: "There is no issue with sqlite migration order and rollback checkpoints.",
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({ sessionId });

    const edges = latestRowsById(
      parseJsonLines<{ id: string; relation: string; updatedAt: number }>(
        join(workspace, "evolves.jsonl"),
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe("enriches");
  });

  test("treats verification status_set as dirty memory trigger", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-verification-"));
    const recorded: string[] = [];
    const sessionId = "memory-engine-verification-session";
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      recordEvent: (event) => {
        recorded.push(event.type);
      },
    });

    engine.ingestEvent(
      taskStatusEvent({
        id: "evt-task-status-verification",
        sessionId,
        phase: "done",
        health: "ok",
        reason: "verification_passed",
      }),
    );

    const snapshot = engine.refreshIfNeeded({
      sessionId,
    });

    expect(snapshot).toBeDefined();
    expect(recorded).toContain("memory_unit_upserted");
    expect(recorded).toContain("memory_working_published");
  });

  test("verification_state_reset resolves stale verification signals", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-verification-reset-"));
    const sessionId = "memory-engine-verification-reset-session";
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
    });

    engine.ingestEvent(
      taskStatusEvent({
        id: "evt-task-status-before-reset",
        sessionId,
        phase: "verify",
        health: "verification_failed",
        reason: "verification_missing",
      }),
    );
    const before = engine.refreshIfNeeded({
      sessionId,
    });
    expect(before).toBeDefined();
    expect(before?.content.toLowerCase().includes("verification")).toBe(true);

    engine.ingestEvent(
      verificationStateResetEvent({
        id: "evt-verification-reset",
        sessionId,
      }),
    );
    const after = engine.refreshIfNeeded({
      sessionId,
    });
    expect(after).toBeDefined();
    expect(after?.content.toLowerCase().includes("verification requires attention")).toBe(false);
    expect(after?.content.toLowerCase().includes("verification_missing")).toBe(false);
  });
});
