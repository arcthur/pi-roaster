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

function verificationOutcomeEvent(input: {
  id: string;
  sessionId: string;
  outcome: "pass" | "fail";
  lessonKey: string;
  pattern: string;
  strategy: string;
  failedChecks?: string[];
  timestamp?: number;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: "verification_outcome_recorded",
    timestamp,
    payload: {
      schema: "brewva.verification.outcome.v1",
      level: "standard",
      outcome: input.outcome,
      lessonKey: input.lessonKey,
      pattern: input.pattern,
      strategy: input.strategy,
      failedChecks: input.failedChecks ?? [],
      missingEvidence: [],
      evidence: input.outcome === "fail" ? "tests: exitCode=1" : "all checks passed",
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

  test("records cognitive relation inference in shadow mode without mutating edge relation", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-cognitive-shadow-"));
    const sessionId = "memory-engine-cognitive-shadow-session";
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
      cognitiveMode: "shadow",
      cognitiveMaxInferenceCallsPerRefresh: 4,
      cognitivePort: {
        inferRelation: () => ({
          relation: "challenges",
          confidence: 0.91,
          rationale: "Newer statement negates previous implementation detail.",
        }),
      },
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
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

    const inferenceEvent = recorded.find((event) => event.type === "cognitive_relation_inference");
    expect(inferenceEvent).toBeDefined();
    expect(inferenceEvent?.payload?.deterministicRelation).toBe("replaces");
    expect(inferenceEvent?.payload?.inferredRelation).toBe("challenges");
  });

  test("active cognitive relation keeps evolves_pending insight aligned with effective relation", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-cognitive-active-insight-"));
    const sessionId = "memory-engine-cognitive-active-insight-session";
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
      cognitiveMode: "active",
      cognitiveMaxInferenceCallsPerRefresh: 4,
      cognitivePort: {
        inferRelation: () => ({
          relation: "enriches",
          confidence: 0.94,
          rationale: "New statement adds context, not a direct replacement.",
        }),
      },
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-active-old",
        sessionId,
        goal: "Use sqlite for current task.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-active-new",
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
    expect(edges[0]?.relation).toBe("enriches");

    const insights = latestRowsById(
      parseJsonLines<{
        id: string;
        kind: string;
        status: string;
        edgeId?: string;
        updatedAt: number;
      }>(join(workspace, "insights.jsonl")),
    );
    const openPending = insights.filter(
      (insight) => insight.kind === "evolves_pending" && insight.status === "open",
    );
    expect(openPending).toHaveLength(0);
    const inferenceEvent = recorded.find((event) => event.type === "cognitive_relation_inference");
    expect(inferenceEvent?.payload?.deterministicRelation).toBe("replaces");
    expect(inferenceEvent?.payload?.inferredRelation).toBe("enriches");
  });

  test("enforces cognitive inference budget per refresh", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-cognitive-budget-"));
    const sessionId = "memory-engine-cognitive-budget-session";
    const recorded: string[] = [];
    let inferCalls = 0;
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "shadow",
      cognitiveMode: "shadow",
      cognitiveMaxInferenceCallsPerRefresh: 1,
      cognitivePort: {
        inferRelation: () => {
          inferCalls += 1;
          return {
            relation: "enriches",
            confidence: 0.7,
            rationale: "Same topic with additive detail.",
          };
        },
      },
      recordEvent: (event) => {
        recorded.push(event.type);
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-old",
        sessionId,
        goal: "Use sqlite for current task.",
        timestamp: Date.now() - 2_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-mid",
        sessionId,
        goal: "Use postgres for current task.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-new",
        sessionId,
        goal: "Use bun instead of esbuild for current task.",
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({ sessionId });

    expect(inferCalls).toBe(1);
    expect(recorded).toContain("cognitive_relation_inference");
    expect(recorded).toContain("cognitive_relation_inference_skipped");
  });

  test("records cognitive relevance ranking in shadow mode without mutating deterministic hits", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-rank-shadow-"));
    const sessionId = "memory-engine-rank-shadow-session";
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      cognitiveMode: "shadow",
      cognitiveMaxRankCandidatesPerSearch: 4,
      cognitivePort: {
        rankRelevance: ({ candidates }) =>
          candidates.map((candidate, index) => ({
            id: candidate.id,
            score: index === candidates.length - 1 ? 1 : 0.01,
          })),
      },
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-retrieval-top",
        sessionId,
        goal: "database migration from sqlite to postgres with rollback",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-retrieval-tail",
        sessionId,
        goal: "update release notes and changelog formatting",
        timestamp: Date.now(),
      }),
    );

    const result = engine.search(sessionId, {
      query: "database migration",
      limit: 3,
    });
    expect(result.hits.length).toBeGreaterThan(1);
    expect(result.hits[0]?.excerpt.toLowerCase().includes("database migration")).toBe(true);

    const rankingEvent = recorded.find((event) => event.type === "cognitive_relevance_ranking");
    expect(rankingEvent).toBeDefined();
    const deterministicTopIds = rankingEvent?.payload?.deterministicTopIds;
    const inferredTopIds = rankingEvent?.payload?.inferredTopIds;
    expect(Array.isArray(deterministicTopIds)).toBe(true);
    expect(Array.isArray(inferredTopIds)).toBe(true);
    expect(
      Array.isArray(deterministicTopIds) &&
        Array.isArray(inferredTopIds) &&
        deterministicTopIds[0] !== inferredTopIds[0],
    ).toBe(true);
  });

  test("does not apply async relevance ranking to sync search results in active mode", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-rank-active-async-"));
    const sessionId = "memory-engine-rank-active-async-session";
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let capturedCandidateIds: string[] = [];
    let resolveRanking: ((value: Array<{ id: string; score: number }>) => void) | undefined;
    const pendingRanking = new Promise<Array<{ id: string; score: number }>>((resolve) => {
      resolveRanking = resolve;
    });

    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      cognitiveMode: "active",
      cognitiveMaxRankCandidatesPerSearch: 4,
      cognitivePort: {
        rankRelevance: ({ candidates }) => {
          capturedCandidateIds = candidates.map((candidate) => candidate.id);
          return pendingRanking;
        },
      },
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-rank-active-async-top",
        sessionId,
        goal: "database migration from sqlite to postgres with rollback",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-rank-active-async-tail",
        sessionId,
        goal: "update release notes and changelog formatting",
        timestamp: Date.now(),
      }),
    );

    const result = engine.search(sessionId, {
      query: "database migration",
      limit: 3,
    });
    const beforeTopIds = result.hits.slice(0, 2).map((hit) => hit.id);
    resolveRanking?.(
      capturedCandidateIds.map((id, index) => ({
        id,
        score: index === capturedCandidateIds.length - 1 ? 1 : 0.01,
      })),
    );
    await Promise.resolve();
    await Promise.resolve();

    const afterTopIds = result.hits.slice(0, 2).map((hit) => hit.id);
    expect(afterTopIds).toEqual(beforeTopIds);

    const skippedEvent = recorded.find(
      (event) => event.type === "cognitive_relevance_ranking_skipped",
    );
    expect(skippedEvent?.payload?.reason).toBe("async_result_not_applicable_to_sync_search");
  });

  test("applies async relevance ranking through searchAsync in active mode", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-rank-active-search-async-"));
    const sessionId = "memory-engine-rank-active-search-async-session";
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let capturedCandidateIds: string[] = [];
    let resolveRanking: ((value: Array<{ id: string; score: number }>) => void) | undefined;
    const pendingRanking = new Promise<Array<{ id: string; score: number }>>((resolve) => {
      resolveRanking = resolve;
    });

    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      cognitiveMode: "active",
      cognitiveMaxRankCandidatesPerSearch: 4,
      cognitivePort: {
        rankRelevance: ({ candidates }) => {
          capturedCandidateIds = candidates.map((candidate) => candidate.id);
          return pendingRanking;
        },
      },
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-rank-active-search-async-top",
        sessionId,
        goal: "database migration from sqlite to postgres with rollback",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-rank-active-search-async-tail",
        sessionId,
        goal: "update release notes and changelog formatting",
        timestamp: Date.now(),
      }),
    );

    const resultPromise = engine.searchAsync(sessionId, {
      query: "database migration",
      limit: 3,
    });
    await Promise.resolve();
    resolveRanking?.(
      capturedCandidateIds.map((id, index) => ({
        id,
        score: index === capturedCandidateIds.length - 1 ? 1 : 0.01,
      })),
    );
    const result = await resultPromise;
    expect(result.hits.length).toBeGreaterThan(1);
    const topIds = result.hits.slice(0, 2).map((hit) => hit.id);
    expect(topIds[0]).toBe(capturedCandidateIds[capturedCandidateIds.length - 1]);

    const rankingEvent = recorded.find((event) => event.type === "cognitive_relevance_ranking");
    expect(rankingEvent?.payload?.asyncResult).toBe(true);
    expect(rankingEvent?.payload?.appliedRanking).toBe(true);
    const skippedEvent = recorded.find(
      (event) => event.type === "cognitive_relevance_ranking_skipped",
    );
    expect(skippedEvent).toBeUndefined();
  });

  test("applies async relevance ranking through buildRecallBlockAsync in active mode", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "brewva-memory-engine-recall-active-search-async-"),
    );
    const sessionId = "memory-engine-recall-active-search-async-session";
    let capturedCandidateIds: string[] = [];
    let resolveRanking: ((value: Array<{ id: string; score: number }>) => void) | undefined;
    const pendingRanking = new Promise<Array<{ id: string; score: number }>>((resolve) => {
      resolveRanking = resolve;
    });

    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      cognitiveMode: "active",
      cognitiveMaxRankCandidatesPerSearch: 4,
      cognitivePort: {
        rankRelevance: ({ candidates }) => {
          capturedCandidateIds = candidates.map((candidate) => candidate.id);
          return pendingRanking;
        },
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-recall-active-search-async-top",
        sessionId,
        goal: "database migration from sqlite to postgres with rollback",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-recall-active-search-async-tail",
        sessionId,
        goal: "update release notes and changelog formatting",
        timestamp: Date.now(),
      }),
    );

    const recallPromise = engine.buildRecallBlockAsync({
      sessionId,
      query: "database migration",
      limit: 3,
    });
    await Promise.resolve();
    resolveRanking?.(
      capturedCandidateIds.map((id, index) => ({
        id,
        score: index === capturedCandidateIds.length - 1 ? 1 : 0.01,
      })),
    );
    const recall = await recallPromise;
    expect(recall.includes("[MemoryRecall]")).toBe(true);
    const lines = recall.split("\n");
    const firstRankLineIndex = lines.findIndex((line) => line.startsWith("1. [unit]"));
    expect(firstRankLineIndex).toBeGreaterThanOrEqual(0);
    const firstExcerpt = lines[firstRankLineIndex + 1] ?? "";
    expect(firstExcerpt.toLowerCase().includes("update release notes")).toBe(true);
  });

  test("includes learning knowledge facets in sync and async recall blocks", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-recall-facets-"));
    const sessionId = "memory-engine-recall-facets-session";
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
      verificationOutcomeEvent({
        id: "evt-recall-facets",
        sessionId,
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; checks=tests:fail",
        failedChecks: ["tests"],
      }),
    );

    const syncRecall = engine.buildRecallBlock({
      sessionId,
      query: "verification lessons",
      limit: 3,
    });
    expect(syncRecall.includes("facets: pattern=verification:standard:none")).toBe(true);
    expect(syncRecall.includes("root_cause=verification checks failed")).toBe(true);
    expect(syncRecall.includes("recommendation=adjust strategy and rerun verification")).toBe(true);
    expect(syncRecall.includes("outcomes=pass:0,fail:1")).toBe(true);

    const asyncRecall = await engine.buildRecallBlockAsync({
      sessionId,
      query: "verification lessons",
      limit: 3,
    });
    expect(asyncRecall.includes("facets: pattern=verification:standard:none")).toBe(true);
    expect(asyncRecall.includes("outcomes=pass:0,fail:1")).toBe(true);
  });

  test("promotes recurring units into global tier and recalls them across sessions", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-global-tier-"));
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 4,
      retrievalTopK: 8,
      evolvesMode: "off",
      globalEnabled: true,
      globalLifecycleCooldownMs: 0,
      globalMinConfidence: 0.8,
      globalMinSessionRecurrence: 2,
      globalDecayIntervalDays: 7,
      globalDecayFactor: 0.95,
      globalPruneBelowConfidence: 0.3,
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-global-a",
        sessionId: "global-a",
        goal: "Use bun test instead of jest for this codebase.",
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.refreshIfNeeded({
      sessionId: "global-a",
    });

    engine.ingestEvent(
      taskSpecEvent({
        id: "evt-task-spec-global-b",
        sessionId: "global-b",
        goal: "Use bun test instead of jest for this codebase.",
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({
      sessionId: "global-b",
    });

    const promoted = recorded.find(
      (event) =>
        event.type === "memory_global_sync" &&
        typeof event.payload?.promoted === "number" &&
        event.payload.promoted > 0,
    );
    expect(promoted).toBeDefined();

    const result = engine.search("global-c", {
      query: "bun test instead of jest",
      limit: 5,
    });
    expect(result.schema).toBe("brewva.memory.search.v1");
    expect(result.version).toBe(1);
    expect(result.rankingModel.schema).toBe("brewva.memory.ranking.v1");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((hit) => hit.excerpt.toLowerCase().includes("bun test"))).toBe(true);
    expect(result.hits[0]?.ranking.rank).toBe(1);

    const recallEvent = recorded.find((event) => event.type === "memory_global_recall");
    expect(recallEvent).toBeDefined();
    expect(Array.isArray(recallEvent?.payload?.topHitSignals)).toBe(true);
  });

  test("compiles global crystals from cross-session recurring patterns", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-global-crystals-"));
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 2,
      retrievalTopK: 12,
      evolvesMode: "off",
      globalEnabled: true,
      globalLifecycleCooldownMs: 0,
      globalMinConfidence: 0.8,
      globalMinSessionRecurrence: 2,
      globalDecayIntervalDays: 7,
      globalDecayFactor: 0.95,
      globalPruneBelowConfidence: 0.3,
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pattern-a1",
        sessionId: "global-pattern-a",
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests:a",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=a",
        failedChecks: ["tests"],
        timestamp: Date.now() - 2_000,
      }),
    );
    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pattern-b1",
        sessionId: "global-pattern-a",
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests:b",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=b",
        failedChecks: ["type-check"],
        timestamp: Date.now() - 1_800,
      }),
    );
    engine.refreshIfNeeded({ sessionId: "global-pattern-a" });

    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pattern-a2",
        sessionId: "global-pattern-b",
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests:a",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=a",
        failedChecks: ["tests"],
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pattern-b2",
        sessionId: "global-pattern-b",
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests:b",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=b",
        failedChecks: ["type-check"],
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({ sessionId: "global-pattern-b" });

    const result = engine.search("global-pattern-c", {
      query: "global pattern verification:standard:none",
      limit: 12,
    });
    const globalCrystalHit = result.hits.find(
      (hit) => hit.kind === "crystal" && hit.topic.includes("global pattern"),
    );
    expect(globalCrystalHit).toBeDefined();
    expect(globalCrystalHit?.crystalProtocol?.schema).toBe("brewva.memory.global-crystal.v1");
    expect(globalCrystalHit?.crystalProtocol?.version).toBe(1);
    expect(globalCrystalHit?.crystalProtocol?.pattern).toBe("verification:standard:none");
    expect(globalCrystalHit?.crystalProtocol?.patterns).toContain("verification:standard:none");
    expect(typeof globalCrystalHit?.crystalProtocol?.rootCause).toBe("string");
    expect(Array.isArray(globalCrystalHit?.crystalProtocol?.rootCauses)).toBe(true);
    expect(typeof globalCrystalHit?.crystalProtocol?.recommendation).toBe("string");
    expect(Array.isArray(globalCrystalHit?.crystalProtocol?.recommendations)).toBe(true);
    expect((globalCrystalHit?.crystalProtocol?.outcomes.fail ?? 0) > 0).toBe(true);
    expect(globalCrystalHit?.knowledgeFacets?.pattern).toBe("verification:standard:none");
    expect(typeof globalCrystalHit?.knowledgeFacets?.rootCause).toBe("string");
    expect(typeof globalCrystalHit?.knowledgeFacets?.recommendation).toBe("string");
    expect((globalCrystalHit?.knowledgeFacets?.outcomes.fail ?? 0) > 0).toBe(true);
    expect(globalCrystalHit?.sourceTier).toBe("global");

    const syncWithCrystals = recorded.find(
      (event) =>
        event.type === "memory_global_sync" &&
        typeof event.payload?.crystalsCompiled === "number" &&
        event.payload.crystalsCompiled > 0,
    );
    expect(syncWithCrystals).toBeDefined();
  });

  test("global fail lessons are cleared when another session confirms pass for same lessonKey", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-engine-global-pass-resolve-"));
    const recorded: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const engine = new MemoryEngine({
      enabled: true,
      rootDir: workspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 2,
      retrievalTopK: 12,
      evolvesMode: "off",
      globalEnabled: true,
      globalLifecycleCooldownMs: 0,
      globalMinConfidence: 0.8,
      globalMinSessionRecurrence: 2,
      globalDecayIntervalDays: 7,
      globalDecayFactor: 0.95,
      globalPruneBelowConfidence: 0.3,
      recordEvent: (event) => {
        recorded.push({ type: event.type, payload: event.payload });
      },
    });

    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pass-resolve-fail-a",
        sessionId: "resolve-a",
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=tests-first",
        failedChecks: ["tests"],
        timestamp: Date.now() - 2_000,
      }),
    );
    engine.refreshIfNeeded({ sessionId: "resolve-a" });

    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pass-resolve-fail-b",
        sessionId: "resolve-b",
        outcome: "fail",
        lessonKey: "verification:standard:none:type-check+tests",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=type-check-first",
        failedChecks: ["type-check"],
        timestamp: Date.now() - 1_000,
      }),
    );
    engine.refreshIfNeeded({ sessionId: "resolve-b" });

    const beforePass = engine.search("resolve-c", {
      query: "verification_outcome_fail lesson_key=verification:standard:none:type-check+tests",
      limit: 8,
    });
    expect(beforePass.hits.length).toBeGreaterThan(0);

    engine.ingestEvent(
      verificationOutcomeEvent({
        id: "evt-global-pass-resolve-pass-c",
        sessionId: "resolve-c",
        outcome: "pass",
        lessonKey: "verification:standard:none:type-check+tests",
        pattern: "verification:standard:none",
        strategy: "verification_level=standard; profile=type-check-first",
        failedChecks: [],
        timestamp: Date.now(),
      }),
    );
    engine.refreshIfNeeded({ sessionId: "resolve-c" });

    const afterPass = engine.search("resolve-d", {
      query: "verification_outcome_fail lesson_key=verification:standard:none:type-check+tests",
      limit: 8,
    });
    expect(
      afterPass.hits.some(
        (hit) =>
          hit.kind === "unit" &&
          hit.excerpt.includes("verification fail") &&
          hit.excerpt.includes("lesson_key=verification:standard:none:type-check+tests"),
      ),
    ).toBe(false);

    const syncWithResolution = recorded.find(
      (event) =>
        event.type === "memory_global_sync" &&
        typeof event.payload?.resolvedByPass === "number" &&
        event.payload.resolvedByPass > 0,
    );
    expect(syncWithResolution).toBeDefined();
  });

  test("rebuildSessionFromTape imports global snapshot from memory_global_sync events", () => {
    const sourceWorkspace = mkdtempSync(
      join(tmpdir(), "brewva-memory-engine-global-replay-source-"),
    );
    const captured: Array<{
      sessionId: string;
      type: string;
      payload?: BrewvaEventRecord["payload"];
    }> = [];
    const sourceEngine = new MemoryEngine({
      enabled: true,
      rootDir: sourceWorkspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 2,
      retrievalTopK: 8,
      evolvesMode: "off",
      globalEnabled: true,
      globalLifecycleCooldownMs: 0,
      globalMinConfidence: 0.8,
      globalMinSessionRecurrence: 2,
      globalDecayIntervalDays: 7,
      globalDecayFactor: 0.95,
      globalPruneBelowConfidence: 0.3,
      recordEvent: (event) => {
        captured.push({
          sessionId: event.sessionId,
          type: event.type,
          payload: event.payload as BrewvaEventRecord["payload"],
        });
      },
    });

    sourceEngine.ingestEvent(
      taskSpecEvent({
        id: "evt-global-replay-a",
        sessionId: "global-replay-a",
        goal: "Use bun test instead of jest for this codebase.",
        timestamp: Date.now() - 1_000,
      }),
    );
    sourceEngine.refreshIfNeeded({ sessionId: "global-replay-a" });
    sourceEngine.ingestEvent(
      taskSpecEvent({
        id: "evt-global-replay-b",
        sessionId: "global-replay-b",
        goal: "Use bun test instead of jest for this codebase.",
        timestamp: Date.now(),
      }),
    );
    sourceEngine.refreshIfNeeded({ sessionId: "global-replay-b" });

    const globalSync = captured.find(
      (event) => event.type === "memory_global_sync" && !!event.payload?.global,
    );
    expect(globalSync).toBeDefined();
    if (!globalSync) return;

    const targetWorkspace = mkdtempSync(
      join(tmpdir(), "brewva-memory-engine-global-replay-target-"),
    );
    const targetEngine = new MemoryEngine({
      enabled: true,
      rootDir: targetWorkspace,
      workingFile: "working.md",
      maxWorkingChars: 2400,
      dailyRefreshHourLocal: 23,
      crystalMinUnits: 2,
      retrievalTopK: 8,
      evolvesMode: "off",
      globalEnabled: true,
      globalLifecycleCooldownMs: 0,
      globalMinConfidence: 0.8,
      globalMinSessionRecurrence: 2,
      globalDecayIntervalDays: 7,
      globalDecayFactor: 0.95,
      globalPruneBelowConfidence: 0.3,
    });
    const replay = targetEngine.rebuildSessionFromTape({
      sessionId: globalSync.sessionId,
      events: [
        {
          id: "evt-memory-global-sync-replay",
          sessionId: globalSync.sessionId,
          type: "memory_global_sync",
          timestamp: Date.now(),
          payload: globalSync.payload,
        },
      ],
      mode: "force",
    });
    expect(replay.replayedEvents).toBe(1);

    const recall = targetEngine.search("global-replay-c", {
      query: "bun test instead of jest",
      limit: 5,
    });
    expect(recall.hits.length).toBeGreaterThan(0);
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
