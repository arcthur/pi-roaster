import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";

describe("memory lifecycle", () => {
  test("buildContextInjection includes working memory after semantic events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-injection-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `memory-injection-${Date.now()}`;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Inject working memory into context",
      constraints: ["Use event tape as trace source"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "verification pending",
      source: "test",
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue implementation");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[WorkingMemory]")).toBe(true);
  });

  test("memory can be disabled from config without changing baseline injection behavior", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-disabled-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = `memory-disabled-${Date.now()}`;
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "No memory block expected",
    });

    const injection = await runtime.context.buildInjection(sessionId, "continue implementation");
    expect(injection.text.includes("[WorkingMemory]")).toBe(false);
  });

  test("dismissMemoryInsight dismisses open insight and emits event", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-dismiss-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `memory-dismiss-${Date.now()}`;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Dismiss repeated memory insight",
    });
    runtime.task.recordBlocker(sessionId, {
      message: "verification may fail due missing fixtures",
      source: "test",
    });
    runtime.task.recordBlocker(sessionId, {
      message: "verification may fail due flaky network",
      source: "test",
    });
    await runtime.context.buildInjection(sessionId, "continue implementation");

    const insightsPath = join(workspace, ".orchestrator/memory/insights.jsonl");
    const rows = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const latestById = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of rows) {
      const current = latestById.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        latestById.set(row.id, row);
      }
    }
    const openInsight = [...latestById.values()].find((row) => row.status === "open");
    expect(openInsight).toBeDefined();
    if (!openInsight) return;

    const dismissed = runtime.memory.dismissInsight(sessionId, openInsight.id);
    expect(dismissed).toEqual({ ok: true });
    const secondDismiss = runtime.memory.dismissInsight(sessionId, openInsight.id);
    expect(secondDismiss).toEqual({ ok: false, error: "not_found" });

    const dismissEvent = runtime.events.query(sessionId, {
      type: "memory_insight_dismissed",
      last: 1,
    })[0];
    expect(dismissEvent).toBeDefined();
    expect((dismissEvent?.payload as { insightId?: string } | undefined)?.insightId).toBe(
      openInsight.id,
    );
  });

  test("reviewMemoryEvolvesEdge accepts proposed edge and emits event", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-memory-review-edge-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.evolvesMode = "shadow";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = `memory-review-edge-${Date.now()}`;

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
    const rows = readFileSync(evolvesPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            status: string;
            relation: string;
            sourceUnitId: string;
            targetUnitId: string;
            updatedAt: number;
          },
      );
    const latestById = new Map<
      string,
      {
        id: string;
        status: string;
        relation: string;
        sourceUnitId: string;
        targetUnitId: string;
        updatedAt: number;
      }
    >();
    for (const row of rows) {
      const current = latestById.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) {
        latestById.set(row.id, row);
      }
    }
    const proposed = [...latestById.values()].find((edge) => edge.status === "proposed");
    expect(proposed).toBeDefined();
    if (!proposed) return;

    const accepted = runtime.memory.reviewEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(accepted).toEqual({ ok: true });
    const second = runtime.memory.reviewEvolvesEdge(sessionId, {
      edgeId: proposed.id,
      decision: "accept",
    });
    expect(second).toEqual({ ok: false, error: "already_set" });

    const reviewEvent = runtime.events.query(sessionId, {
      type: "memory_evolves_edge_reviewed",
      last: 1,
    })[0];
    expect(reviewEvent).toBeDefined();
    expect((reviewEvent?.payload as { edgeId?: string } | undefined)?.edgeId).toBe(proposed.id);

    const unitsPath = join(workspace, ".orchestrator/memory/units.jsonl");
    const unitRows = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; updatedAt: number });
    const unitsLatest = new Map<string, { id: string; status: string; updatedAt: number }>();
    for (const row of unitRows) {
      const existing = unitsLatest.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        unitsLatest.set(row.id, row);
      }
    }
    expect(unitsLatest.get(proposed.targetUnitId)?.status).toBe("superseded");
    expect(unitsLatest.get(proposed.sourceUnitId)?.status).toBe("active");

    const insightsPath = join(workspace, ".orchestrator/memory/insights.jsonl");
    const insightRows = readFileSync(insightsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            kind?: string;
            status: string;
            edgeId?: string | null;
            updatedAt: number;
          },
      );
    const insightsLatest = new Map<
      string,
      { id: string; kind?: string; status: string; edgeId?: string | null; updatedAt: number }
    >();
    for (const row of insightRows) {
      const existing = insightsLatest.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        insightsLatest.set(row.id, row);
      }
    }
    const evolvesInsight = [...insightsLatest.values()].find(
      (row) => row.kind === "evolves_pending" && row.edgeId === proposed.id,
    );
    expect(evolvesInsight).toBeDefined();
    expect(evolvesInsight?.status).toBe("dismissed");

    const supersedeEvent = runtime.events.query(sessionId, {
      type: "memory_unit_superseded",
      last: 1,
    })[0];
    expect(supersedeEvent).toBeDefined();
  });
});
