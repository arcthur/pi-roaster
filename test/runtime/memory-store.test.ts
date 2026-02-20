import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type MemoryUnitCandidate } from "@brewva/brewva-runtime";

function candidate(input: {
  sessionId?: string;
  topic: string;
  statement: string;
  metadata?: MemoryUnitCandidate["metadata"];
}): MemoryUnitCandidate {
  return {
    sessionId: input.sessionId ?? "memory-store-session",
    type: "risk",
    status: "active",
    topic: input.topic,
    statement: input.statement,
    confidence: 0.85,
    metadata: input.metadata,
    sourceRefs: [
      {
        eventId: `evt-${input.topic}`,
        eventType: "task_event",
        sessionId: input.sessionId ?? "memory-store-session",
        timestamp: Date.now(),
      },
    ],
  };
}

describe("memory store", () => {
  test("resolveUnits supports memory_signal directives", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-signal-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    const verification = store.upsertUnit(
      candidate({
        topic: "verification",
        statement: "verification requires attention",
        metadata: {
          taskKind: "status_set",
          memorySignal: "verification",
        },
      }),
    ).unit;
    const generic = store.upsertUnit(
      candidate({
        topic: "task status",
        statement: "phase=execute; health=ok",
        metadata: {
          taskKind: "status_set",
        },
      }),
    ).unit;

    const resolved = store.resolveUnits({
      sessionId: "memory-store-session",
      sourceType: "memory_signal",
      sourceId: "verification",
      resolvedAt: Date.now(),
    });

    expect(resolved).toBe(1);
    const units = store.listUnits("memory-store-session");
    expect(units.find((unit) => unit.id === verification.id)?.status).toBe("resolved");
    expect(units.find((unit) => unit.id === generic.id)?.status).toBe("active");
  });

  test("resolveUnits supports task_kind directives", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-taskkind-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    const statusUnit = store.upsertUnit(
      candidate({
        topic: "task status",
        statement: "phase=verify; health=verification_failed",
        metadata: {
          taskKind: "status_set",
        },
      }),
    ).unit;
    const specUnit = store.upsertUnit(
      candidate({
        topic: "task goal",
        statement: "ship memory system",
        metadata: {
          taskKind: "spec_set",
        },
      }),
    ).unit;

    const resolved = store.resolveUnits({
      sessionId: "memory-store-session",
      sourceType: "task_kind",
      sourceId: "status_set",
      resolvedAt: Date.now(),
    });

    expect(resolved).toBe(1);
    const units = store.listUnits("memory-store-session");
    expect(units.find((unit) => unit.id === statusUnit.id)?.status).toBe("resolved");
    expect(units.find((unit) => unit.id === specUnit.id)?.status).toBe("active");
  });

  test("resolveUnits remains durable when resolvedAt is stale", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-resolve-stale-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    const upserted = store.upsertUnit(
      candidate({
        topic: "verification",
        statement: "verification requires attention",
        metadata: {
          taskKind: "status_set",
          memorySignal: "verification",
        },
      }),
    ).unit;

    const staleResolvedAt = Math.max(0, upserted.updatedAt - 5_000);
    const resolved = store.resolveUnits({
      sessionId: "memory-store-session",
      sourceType: "memory_signal",
      sourceId: "verification",
      resolvedAt: staleResolvedAt,
    });
    expect(resolved).toBe(1);

    const reloaded = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });
    const restored = reloaded
      .listUnits("memory-store-session")
      .find((unit) => unit.id === upserted.id);
    expect(restored?.status).toBe("resolved");
  });

  test("dismissInsight transitions open insight to dismissed once", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-dismiss-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    const insight = store.addInsight({
      sessionId: "memory-store-session",
      kind: "conflict",
      status: "open",
      message: "Potential conflict in topic 'verification'.",
      relatedUnitIds: ["u1", "u2"],
    });

    expect(store.dismissInsight(insight.id)).toBe(true);
    expect(store.dismissInsight(insight.id)).toBe(false);

    const latest = store
      .listInsights("memory-store-session")
      .find((item) => item.id === insight.id);
    expect(latest?.status).toBe("dismissed");
  });

  test("compacts append-only units log after threshold writes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-store-compact-"));
    const store = new MemoryStore({
      rootDir,
      workingFile: "working.md",
    });

    for (let index = 0; index < 560; index += 1) {
      store.upsertUnit(
        candidate({
          topic: "verification",
          statement: "verification requires attention",
          metadata: {
            taskKind: "status_set",
            memorySignal: "verification",
            iteration: index,
          },
        }),
      );
    }

    const unitsPath = join(rootDir, "units.jsonl");
    const lines = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(lines.length).toBeLessThan(200);
  });
});
