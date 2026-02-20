import { describe, expect, test } from "bun:test";
import { searchMemory, type MemoryCrystal, type MemoryUnit } from "@brewva/brewva-runtime";

function unit(input: {
  id: string;
  topic: string;
  statement: string;
  sessionId?: string;
  confidence?: number;
  type?: MemoryUnit["type"];
  status?: MemoryUnit["status"];
  metadata?: MemoryUnit["metadata"];
  updatedAt?: number;
}): MemoryUnit {
  const timestamp = input.updatedAt ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId ?? "mem-retrieval-session",
    type: input.type ?? "fact",
    status: input.status ?? "active",
    topic: input.topic,
    statement: input.statement,
    confidence: input.confidence ?? 0.8,
    fingerprint: `fp-${input.id}`,
    sourceRefs: [],
    metadata: input.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  };
}

function crystal(
  id: string,
  topic: string,
  summary: string,
  input?: { confidence?: number; updatedAt?: number },
): MemoryCrystal {
  const timestamp = input?.updatedAt ?? Date.now();
  return {
    id,
    sessionId: "mem-retrieval-session",
    topic,
    summary,
    unitIds: ["u1"],
    confidence: input?.confidence ?? 0.9,
    sourceRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("memory retrieval", () => {
  test("returns top hits by hybrid lexical/recency/confidence score", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "database architecture migration",
      limit: 3,
      units: [
        unit({
          id: "u1",
          topic: "database architecture",
          statement: "migrate from sqlite to postgres with staged rollout",
          confidence: 0.95,
        }),
        unit({
          id: "u2",
          topic: "frontend ui",
          statement: "update typography scale",
          confidence: 0.7,
        }),
      ],
      crystals: [
        crystal(
          "c1",
          "database architecture",
          "[Crystal]\n- staged migration.\n- rollback safety.",
        ),
      ],
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.topic.toLowerCase().includes("database")).toBe(true);
  });

  test("drops candidates without lexical overlap", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "build cache key strategy",
      limit: 5,
      units: [
        unit({
          id: "u1",
          topic: "frontend layout",
          statement: "adjust sidebar spacing and typography scale",
          confidence: 0.99,
          updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        }),
      ],
      crystals: [
        crystal("c1", "ui polish", "[Crystal]\n- tighten spacing rhythm.", {
          updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        }),
      ],
    });

    expect(result.hits).toHaveLength(0);
  });

  test("supports alias-based recall for database terminology", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "database migration plan",
      limit: 5,
      units: [
        unit({
          id: "u1",
          topic: "postgres rollout",
          statement: "move writes from sqlite to postgresql in staged steps",
          confidence: 0.9,
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.topic).toContain("postgres");
  });

  test("keeps verification status signal units searchable", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "verification passed",
      limit: 5,
      units: [
        unit({
          id: "u1",
          topic: "verification",
          statement: "verification passed for current task",
          type: "learning",
          status: "resolved",
          metadata: {
            taskKind: "status_set",
            memorySignal: "verification",
          },
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.topic).toBe("verification");
  });

  test("ignores generic status_set candidates even with lexical overlap", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "phase execute",
      limit: 5,
      units: [
        unit({
          id: "u1",
          topic: "task status",
          statement: "phase=execute; health=ok; reason=open_items=2",
          metadata: {
            taskKind: "status_set",
          },
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(0);
  });

  test("returns empty hits for empty query", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "   ",
      limit: 5,
      units: [unit({ id: "u1", topic: "database", statement: "keep event tape" })],
      crystals: [],
    });

    expect(result.hits).toHaveLength(0);
    expect(result.scanned).toBe(0);
  });

  test("supports retrieval weight tuning for non-lexical recall", () => {
    const units = [
      unit({
        id: "u1",
        topic: "database architecture",
        statement: "database migration strategy and schema rollout",
        confidence: 0.2,
        updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      }),
      unit({
        id: "u2",
        topic: "recent execution",
        statement: "cache invalidation strategy for hot paths",
        confidence: 0.95,
        updatedAt: Date.now(),
      }),
    ];

    const defaultWeighted = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "database migration",
      limit: 2,
      units,
      crystals: [],
    });
    expect(defaultWeighted.hits[0]?.id).toBe("u1");

    const recallWeighted = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "database migration",
      limit: 2,
      units,
      crystals: [],
      weights: {
        lexical: 0.05,
        recency: 0.55,
        confidence: 0.4,
      },
    });
    expect(recallWeighted.hits[0]?.id).toBe("u2");
  });
});
