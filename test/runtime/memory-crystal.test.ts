import { describe, expect, test } from "bun:test";
import { compileCrystalDrafts } from "@brewva/brewva-runtime";
import { createMemoryUnitFactory } from "../fixtures/memory.js";

const unit = createMemoryUnitFactory({
  sessionId: "mem-crystal-session",
  type: "fact",
  status: "active",
  confidence: 0.8,
  updatedAt: 1_700_000_000_000,
  sourceRefsFactory: (input, timestamp) => [
    {
      eventId: `evt-${input.id}`,
      eventType: "truth_event",
      sessionId: input.sessionId ?? "mem-crystal-session",
      timestamp,
    },
  ],
});

describe("memory crystal compiler", () => {
  test("given enough active units under one topic, when compiling drafts, then a crystal draft is produced", () => {
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

  test("given superseded and active units, when compiling drafts, then superseded units are excluded", () => {
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

  test("given empty units, when compiling drafts, then result is empty", () => {
    const drafts = compileCrystalDrafts({
      sessionId: "mem-crystal-session",
      minUnits: 1,
      units: [],
    });
    expect(drafts).toEqual([]);
  });

  test("given only superseded units, when compiling drafts, then result is empty", () => {
    const drafts = compileCrystalDrafts({
      sessionId: "mem-crystal-session",
      minUnits: 1,
      units: [
        unit({ id: "u1", topic: "tests", statement: "run tests", status: "superseded" }),
        unit({ id: "u2", topic: "tests", statement: "retry failed tests", status: "superseded" }),
      ],
    });
    expect(drafts).toEqual([]);
  });

  test("given topic units below minUnits, when compiling drafts, then result is empty", () => {
    const drafts = compileCrystalDrafts({
      sessionId: "mem-crystal-session",
      minUnits: 2,
      units: [unit({ id: "u1", topic: "database", statement: "switch to postgres" })],
    });
    expect(drafts).toEqual([]);
  });

  test("given minUnits is zero, when compiling drafts, then single-unit topics are allowed", () => {
    const drafts = compileCrystalDrafts({
      sessionId: "mem-crystal-session",
      minUnits: 0,
      units: [
        unit({ id: "u1", topic: "database", statement: "switch to postgres" }),
        unit({ id: "u2", topic: "frontend", statement: "optimize loading state" }),
      ],
    });
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.topic).toSorted()).toEqual(["database", "frontend"]);
    expect(drafts.every((draft) => draft.unitIds.length === 1)).toBe(true);
  });
});
