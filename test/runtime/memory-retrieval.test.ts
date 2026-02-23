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
  input?: {
    sessionId?: string;
    confidence?: number;
    updatedAt?: number;
    metadata?: MemoryCrystal["metadata"];
  },
): MemoryCrystal {
  const timestamp = input?.updatedAt ?? Date.now();
  return {
    id,
    sessionId: input?.sessionId ?? "mem-retrieval-session",
    topic,
    summary,
    unitIds: ["u1"],
    confidence: input?.confidence ?? 0.9,
    sourceRefs: [],
    metadata: input?.metadata,
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

    expect(result.schema).toBe("brewva.memory.search.v1");
    expect(result.version).toBe(1);
    expect(result.rankingModel.schema).toBe("brewva.memory.ranking.v1");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.topic.toLowerCase().includes("database")).toBe(true);
    expect(result.hits[0]?.ranking.schema).toBe("brewva.memory.ranking.v1");
    expect(result.hits[0]?.ranking.rank).toBe(1);
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

  test("can include selected cross-session units (global tier)", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      includeSessionIds: ["__global__"],
      query: "bun test command",
      limit: 5,
      units: [
        unit({
          id: "u-global",
          sessionId: "__global__",
          topic: "test runner",
          statement: "use bun test instead of jest in this codebase",
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.id).toBe("u-global");
    expect(result.hits[0]?.sourceTier).toBe("global");
  });

  test("exposes query-time ranking signals for each hit", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "database migration",
      limit: 5,
      units: [
        unit({
          id: "u1",
          topic: "database migration",
          statement: "migrate sqlite to postgres with rollout",
          confidence: 0.92,
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    const ranking = result.hits[0]?.ranking;
    expect(ranking?.schema).toBe("brewva.memory.ranking.v1");
    expect(ranking?.rank).toBe(1);
    expect(typeof ranking?.lexical).toBe("number");
    expect(typeof ranking?.weightedLexical).toBe("number");
    expect(typeof ranking?.weightedRecency).toBe("number");
    expect(typeof ranking?.weightedConfidence).toBe("number");
  });

  test("returns structured global crystal protocol on crystal hits", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      includeSessionIds: ["__global__"],
      query: "verification standard pattern",
      limit: 5,
      units: [],
      crystals: [
        crystal(
          "c-global",
          "global pattern: verification:standard:none",
          "[GlobalCrystal]\n- pattern: verification:standard:none",
          {
            sessionId: "__global__",
            metadata: {
              globalCrystal: {
                schema: "brewva.memory.global-crystal.v1",
                version: 1,
                pattern: "verification:standard:none",
                patterns: ["verification:standard:none"],
                rootCause: "failed checks: tests",
                rootCauses: ["failed checks: tests"],
                recommendation: "run type-check before tests",
                recommendations: ["run type-check before tests"],
                lessonKeys: ["verification:standard:none:type-check+tests"],
                outcomes: { pass: 1, fail: 4 },
                sourceSessionIds: ["s1", "s2"],
                sourceSessionCount: 2,
                unitCount: 4,
                updatedAt: Date.now(),
              },
            },
          },
        ),
      ],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.kind).toBe("crystal");
    expect(result.hits[0]?.sourceTier).toBe("global");
    expect(result.hits[0]?.crystalProtocol?.schema).toBe("brewva.memory.global-crystal.v1");
    expect(result.hits[0]?.crystalProtocol?.version).toBe(1);
    expect(result.hits[0]?.crystalProtocol?.pattern).toBe("verification:standard:none");
    expect(result.hits[0]?.crystalProtocol?.patterns).toEqual(["verification:standard:none"]);
    expect(result.hits[0]?.crystalProtocol?.rootCause).toBe("failed checks: tests");
    expect(result.hits[0]?.crystalProtocol?.rootCauses).toEqual(["failed checks: tests"]);
    expect(result.hits[0]?.crystalProtocol?.recommendation).toBe("run type-check before tests");
    expect(result.hits[0]?.crystalProtocol?.outcomes).toEqual({ pass: 1, fail: 4 });
    expect(result.hits[0]?.knowledgeFacets?.pattern).toBe("verification:standard:none");
    expect(result.hits[0]?.knowledgeFacets?.rootCause).toBe("failed checks: tests");
    expect(result.hits[0]?.knowledgeFacets?.recommendation).toBe("run type-check before tests");
    expect(result.hits[0]?.knowledgeFacets?.lessonKey).toBe(
      "verification:standard:none:type-check+tests",
    );
    expect(result.hits[0]?.knowledgeFacets?.outcomes).toEqual({ pass: 1, fail: 4 });
  });

  test("keeps legacy global crystal hits readable when outcomes are missing", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      includeSessionIds: ["__global__"],
      query: "verification standard pattern",
      limit: 5,
      units: [],
      crystals: [
        crystal(
          "c-global-legacy",
          "global pattern: verification:standard:none",
          "[GlobalCrystal]\n- pattern: verification:standard:none",
          {
            sessionId: "__global__",
            metadata: {
              globalCrystal: {
                schema: "brewva.memory.global-crystal.v1",
                version: 1,
                pattern: "verification:standard:none",
                rootCauses: ["failed checks: tests"],
                recommendations: ["run type-check before tests"],
                lessonKeys: ["verification:standard:none:type-check+tests"],
                sourceSessionIds: ["s1", "s2"],
                sourceSessionCount: 2,
                unitCount: 4,
                updatedAt: Date.now(),
              },
            },
          },
        ),
      ],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.crystalProtocol?.schema).toBe("brewva.memory.global-crystal.v1");
    expect(result.hits[0]?.knowledgeFacets?.outcomes).toEqual({ pass: 0, fail: 0 });
  });

  test("returns structured global lesson protocol on global learning unit hits", () => {
    const now = Date.now();
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      includeSessionIds: ["__global__"],
      query: "verification lessons pattern",
      limit: 5,
      units: [
        unit({
          id: "u-global-lesson",
          sessionId: "__global__",
          topic: "verification lessons",
          statement: "verification fail pattern repeated across sessions",
          type: "learning",
          metadata: {
            globalLesson: {
              schema: "brewva.memory.global-lesson.v1",
              version: 1,
              lessonKey: "verification:standard:none:type-check+tests",
              pattern: "verification:standard:none",
              patterns: ["verification:standard:none"],
              rootCause: "failed checks: tests",
              rootCauses: ["failed checks: tests", "missing evidence: test_or_build"],
              recommendation: "run type-check before tests",
              recommendations: ["run type-check before tests", "capture missing evidence first"],
              outcomes: { pass: 0, fail: 3 },
              sourceSessionIds: ["s1", "s2", "s3"],
              sourceSessionCount: 3,
              updatedAt: now,
            },
          },
          updatedAt: now,
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.kind).toBe("unit");
    expect(result.hits[0]?.sourceTier).toBe("global");
    expect(result.hits[0]?.lessonProtocol?.schema).toBe("brewva.memory.global-lesson.v1");
    expect(result.hits[0]?.lessonProtocol?.lessonKey).toBe(
      "verification:standard:none:type-check+tests",
    );
    expect(result.hits[0]?.lessonProtocol?.rootCauses).toEqual([
      "failed checks: tests",
      "missing evidence: test_or_build",
    ]);
    expect(result.hits[0]?.knowledgeFacets?.pattern).toBe("verification:standard:none");
    expect(result.hits[0]?.knowledgeFacets?.rootCause).toBe("failed checks: tests");
    expect(result.hits[0]?.knowledgeFacets?.recommendation).toBe("run type-check before tests");
    expect(result.hits[0]?.knowledgeFacets?.lessonKey).toBe(
      "verification:standard:none:type-check+tests",
    );
    expect(result.hits[0]?.knowledgeFacets?.outcomes).toEqual({ pass: 0, fail: 3 });
    expect(result.hits[0]?.knowledgeFacets?.unitCount).toBeNull();
  });

  test("projects knowledge facets for session learning units without global protocol", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "verification lessons strategy",
      limit: 5,
      units: [
        unit({
          id: "u-session-lesson",
          topic: "verification lessons",
          statement: "verification failed and strategy must be adjusted",
          type: "learning",
          metadata: {
            lessonKey: "verification:standard:none:type-check+tests",
            pattern: "verification:standard:none",
            rootCause: "failed checks: tests",
            recommendation: "run type-check before tests",
            lessonOutcome: "fail",
          },
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.sourceTier).toBe("session");
    expect(result.hits[0]?.lessonProtocol).toBeUndefined();
    expect(result.hits[0]?.knowledgeFacets?.pattern).toBe("verification:standard:none");
    expect(result.hits[0]?.knowledgeFacets?.rootCause).toBe("failed checks: tests");
    expect(result.hits[0]?.knowledgeFacets?.recommendation).toBe("run type-check before tests");
    expect(result.hits[0]?.knowledgeFacets?.lessonKey).toBe(
      "verification:standard:none:type-check+tests",
    );
    expect(result.hits[0]?.knowledgeFacets?.outcomes).toEqual({ pass: 0, fail: 1 });
  });

  test("keeps legacy global lesson hits readable when outcomes are missing", () => {
    const now = Date.now();
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      includeSessionIds: ["__global__"],
      query: "verification lessons pattern",
      limit: 5,
      units: [
        unit({
          id: "u-global-lesson-legacy",
          sessionId: "__global__",
          topic: "verification lessons",
          statement: "legacy global lesson payload",
          type: "learning",
          metadata: {
            globalLesson: {
              schema: "brewva.memory.global-lesson.v1",
              version: 1,
              lessonKey: "verification:standard:none:type-check+tests",
              pattern: "verification:standard:none",
              rootCauses: ["failed checks: tests"],
              recommendations: ["run type-check before tests"],
              sourceSessionIds: ["s1", "s2"],
              sourceSessionCount: 2,
              updatedAt: now,
            },
          },
          updatedAt: now,
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.lessonProtocol?.schema).toBe("brewva.memory.global-lesson.v1");
    expect(result.hits[0]?.lessonProtocol?.outcomes).toEqual({ pass: 0, fail: 0 });
    expect(result.hits[0]?.knowledgeFacets?.outcomes).toEqual({ pass: 0, fail: 0 });
  });

  test("projects protocol-agnostic knowledge facets for both lesson and crystal hits", () => {
    const now = Date.now();
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      includeSessionIds: ["__global__"],
      query: "verification standard none tests",
      limit: 10,
      units: [
        unit({
          id: "u-global-lesson-facets",
          sessionId: "__global__",
          topic: "verification lessons",
          statement: "verification fail pattern",
          type: "learning",
          metadata: {
            globalLesson: {
              schema: "brewva.memory.global-lesson.v1",
              version: 1,
              lessonKey: "verification:standard:none:type-check+tests",
              pattern: "verification:standard:none",
              patterns: ["verification:standard:none"],
              rootCause: "failed checks: tests",
              rootCauses: ["failed checks: tests"],
              recommendation: "run type-check before tests",
              recommendations: ["run type-check before tests"],
              outcomes: { pass: 0, fail: 2 },
              sourceSessionIds: ["s1", "s2"],
              sourceSessionCount: 2,
              updatedAt: now,
            },
          },
          updatedAt: now,
        }),
      ],
      crystals: [
        crystal(
          "c-global-facets",
          "global pattern: verification:standard:none",
          "[GlobalCrystal]\n- pattern: verification:standard:none",
          {
            sessionId: "__global__",
            metadata: {
              globalCrystal: {
                schema: "brewva.memory.global-crystal.v1",
                version: 1,
                pattern: "verification:standard:none",
                patterns: ["verification:standard:none"],
                rootCause: "failed checks: tests",
                rootCauses: ["failed checks: tests"],
                recommendation: "run type-check before tests",
                recommendations: ["run type-check before tests"],
                lessonKeys: ["verification:standard:none:type-check+tests"],
                outcomes: { pass: 1, fail: 5 },
                sourceSessionIds: ["s1", "s2", "s3"],
                sourceSessionCount: 3,
                unitCount: 4,
                updatedAt: now,
              },
            },
          },
        ),
      ],
    });

    expect(result.hits).toHaveLength(2);
    for (const hit of result.hits) {
      expect(hit.knowledgeFacets).toBeDefined();
      expect(hit.knowledgeFacets?.pattern).toBe("verification:standard:none");
      expect(hit.knowledgeFacets?.rootCause).toBe("failed checks: tests");
      expect(hit.knowledgeFacets?.recommendation).toBe("run type-check before tests");
      expect(hit.knowledgeFacets?.lessonKey).toBe("verification:standard:none:type-check+tests");
    }
  });

  test("skips resolved failed lessons after pass reconciliation", () => {
    const result = searchMemory({
      sessionId: "mem-retrieval-session",
      query: "verification failed tests",
      limit: 5,
      units: [
        unit({
          id: "u-fail-resolved",
          topic: "verification lessons",
          statement: "verification fail; failed_checks=tests",
          type: "learning",
          status: "resolved",
          metadata: {
            lessonOutcome: "fail",
          },
        }),
      ],
      crystals: [],
    });

    expect(result.hits).toHaveLength(0);
  });
});
