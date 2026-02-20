import { describe, expect, test } from "bun:test";
import { compileCrystalDrafts, type MemoryUnit } from "@brewva/brewva-runtime";

function unit(input: {
  id: string;
  topic: string;
  statement: string;
  sessionId?: string;
  confidence?: number;
  status?: MemoryUnit["status"];
  updatedAt?: number;
}): MemoryUnit {
  const timestamp = input.updatedAt ?? 1_700_000_000_000;
  return {
    id: input.id,
    sessionId: input.sessionId ?? "mem-crystal-session",
    type: "fact",
    status: input.status ?? "active",
    topic: input.topic,
    statement: input.statement,
    confidence: input.confidence ?? 0.8,
    fingerprint: `fp-${input.id}`,
    sourceRefs: [
      {
        eventId: `evt-${input.id}`,
        eventType: "truth_event",
        sessionId: input.sessionId ?? "mem-crystal-session",
        timestamp,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  };
}

describe("memory crystal compiler", () => {
  test("compiles draft when topic has enough units", () => {
    const drafts = compileCrystalDrafts({
      sessionId: "mem-crystal-session",
      minUnits: 3,
      units: [
        unit({ id: "u1", topic: "database", statement: "switch to postgres" }),
        unit({ id: "u2", topic: "database", statement: "add migration checks" }),
        unit({ id: "u3", topic: "database", statement: "track slow queries" }),
        unit({ id: "u4", topic: "frontend", statement: "improve loading skeleton" }),
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.topic).toBe("database");
    expect(drafts[0]?.unitIds).toHaveLength(3);
    expect(drafts[0]?.summary.includes("[Crystal]")).toBe(true);
  });

  test("ignores superseded units while grouping", () => {
    const drafts = compileCrystalDrafts({
      sessionId: "mem-crystal-session",
      minUnits: 2,
      units: [
        unit({ id: "u1", topic: "tests", statement: "run full suite", status: "superseded" }),
        unit({ id: "u2", topic: "tests", statement: "run focused tests" }),
        unit({ id: "u3", topic: "tests", statement: "run regression tests" }),
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.unitIds).toHaveLength(2);
    expect(drafts[0]?.unitIds).toEqual(expect.arrayContaining(["u2", "u3"]));
  });
});
