import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_MEMORY_SESSION_ID, GlobalMemoryTier } from "@brewva/brewva-runtime";
import { createMemoryUnitFactory } from "../fixtures/memory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const unit = createMemoryUnitFactory({
  type: "fact",
  status: "active",
  confidence: 0.9,
  sourceRefs: [],
});

describe("global memory tier", () => {
  test("promotes repeated cross-session units into global tier", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-promote-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const sharedA = unit({
      id: "u-a",
      sessionId: "session-a",
      topic: "test runner",
      statement: "use bun test instead of jest",
      fingerprint: "shared-runner",
      updatedAt: now,
    });
    const first = tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: [sharedA],
      allUnits: [sharedA],
      now,
    });
    expect(first.promoted).toBe(0);

    const sharedB = unit({
      id: "u-b",
      sessionId: "session-b",
      topic: "test runner",
      statement: "use bun test instead of jest",
      fingerprint: "shared-runner",
      updatedAt: now + 1,
    });
    const second = tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sharedB],
      allUnits: [sharedA, sharedB],
      now: now + 1,
    });

    expect(second.promoted).toBe(1);
    const globals = tier.listUnits();
    expect(globals).toHaveLength(1);
    expect(globals[0]?.sessionId).toBe(GLOBAL_MEMORY_SESSION_ID);
    expect(globals[0]?.confidence).toBe(1);
    const metadata = globals[0]?.metadata;
    expect(metadata?.recurrence).toBe(2);
    expect(metadata?.sourceSessionIds).toEqual(["session-a", "session-b"]);
  });

  test("promotes lessons by lessonKey even when statements differ across sessions", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-lesson-key-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const sessionA = unit({
      id: "lesson-a",
      sessionId: "session-a",
      topic: "verification lessons",
      statement: "verification fail; strategy=run tests first",
      fingerprint: "lesson-fp-a",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "fail",
        pattern: "verification:standard:none",
        rootCause: "failed checks: tests",
        recommendation: "run type-check before tests",
      },
      updatedAt: now - 1,
    });
    const first = tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: [sessionA],
      allUnits: [sessionA],
      now: now - 1,
    });
    expect(first.promoted).toBe(0);

    const sessionB = unit({
      id: "lesson-b",
      sessionId: "session-b",
      topic: "verification lessons",
      statement: "verification fail; strategy=run type-check before tests",
      fingerprint: "lesson-fp-b",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "fail",
        pattern: "verification:standard:none",
        rootCause: "missing evidence: test_or_build",
        recommendation: "capture command evidence and rerun",
      },
      updatedAt: now,
    });
    const second = tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sessionB],
      allUnits: [sessionA, sessionB],
      now,
    });
    expect(second.promoted).toBe(1);
    const globalUnits = tier.listUnits();
    expect(globalUnits).toHaveLength(1);
    const metadata = globalUnits[0]?.metadata;
    expect(metadata?.lessonKey).toBe("verification:standard:none:type-check+tests");
    expect(metadata?.pattern).toBe("verification:standard:none");
    expect(metadata?.rootCauses).toEqual([
      "missing evidence: test_or_build",
      "failed checks: tests",
    ]);
    expect(metadata?.recommendations).toEqual([
      "capture command evidence and rerun",
      "run type-check before tests",
    ]);
    const lessonProtocol = metadata?.globalLesson as
      | {
          schema?: string;
          version?: number;
          lessonKey?: string;
          pattern?: string;
          rootCauses?: string[];
          recommendations?: string[];
          sourceSessionCount?: number;
          outcomes?: { pass?: number; fail?: number };
        }
      | undefined;
    expect(lessonProtocol?.schema).toBe("brewva.memory.global-lesson.v1");
    expect(lessonProtocol?.version).toBe(1);
    expect(lessonProtocol?.lessonKey).toBe("verification:standard:none:type-check+tests");
    expect(lessonProtocol?.pattern).toBe("verification:standard:none");
    expect(lessonProtocol?.rootCauses).toEqual([
      "missing evidence: test_or_build",
      "failed checks: tests",
    ]);
    expect(lessonProtocol?.recommendations).toEqual([
      "capture command evidence and rerun",
      "run type-check before tests",
    ]);
    expect(lessonProtocol?.sourceSessionCount).toBe(2);
    expect(lessonProtocol?.outcomes?.fail).toBeGreaterThan(0);
  });

  test("does not inflate lesson outcomes on repeated lifecycle refresh", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-lesson-outcomes-stable-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const sessionA = unit({
      id: "lesson-a",
      sessionId: "session-a",
      topic: "verification lessons",
      statement: "verification fail A",
      fingerprint: "lesson-a-fp",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "fail",
      },
      updatedAt: now - 1,
    });
    const sessionB = unit({
      id: "lesson-b",
      sessionId: "session-b",
      topic: "verification lessons",
      statement: "verification fail B",
      fingerprint: "lesson-b-fp",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "fail",
      },
      updatedAt: now,
    });

    tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: [sessionA],
      allUnits: [sessionA],
      now: now - 1,
    });
    tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sessionB],
      allUnits: [sessionA, sessionB],
      now,
    });

    const firstMetadata = tier.listUnits()[0]?.metadata;
    const firstOutcomes = (
      firstMetadata?.globalLesson as { outcomes?: { fail?: number } } | undefined
    )?.outcomes;
    expect(firstOutcomes?.fail).toBe(2);

    tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sessionB],
      allUnits: [sessionA, sessionB],
      now: now + 1,
    });

    const secondMetadata = tier.listUnits()[0]?.metadata;
    const secondOutcomes = (
      secondMetadata?.globalLesson as { outcomes?: { fail?: number } } | undefined
    )?.outcomes;
    expect(secondOutcomes?.fail).toBe(2);
  });

  test("decays and prunes stale global units", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-decay-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 1,
      decayFactor: 0.5,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const sharedA = unit({
      id: "u-a",
      sessionId: "session-a",
      topic: "build command",
      statement: "run bun build for packaging",
      fingerprint: "shared-build",
      updatedAt: now,
    });
    const sharedB = unit({
      id: "u-b",
      sessionId: "session-b",
      topic: "build command",
      statement: "run bun build for packaging",
      fingerprint: "shared-build",
      updatedAt: now + 1,
    });

    tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: [sharedA],
      allUnits: [sharedA],
      now,
    });
    tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sharedB],
      allUnits: [sharedA, sharedB],
      now: now + 1,
    });

    const decayed = tier.runLifecycle({
      sessionId: "session-c",
      sessionUnits: [],
      allUnits: [],
      now: now + 2 * DAY_MS + 10,
    });

    expect(decayed.pruned).toBe(1);
    expect(tier.listUnits()).toHaveLength(0);
  });

  test("reconfirmation restores decayed unit confidence to 1.0", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-refresh-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 1,
      decayFactor: 0.8,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const sharedA = unit({
      id: "u-a",
      sessionId: "session-a",
      topic: "test runner",
      statement: "use bun test instead of jest",
      fingerprint: "shared-runner",
      updatedAt: now,
    });
    const sharedB = unit({
      id: "u-b",
      sessionId: "session-b",
      topic: "test runner",
      statement: "use bun test instead of jest",
      fingerprint: "shared-runner",
      updatedAt: now + 1,
    });

    tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: [sharedA],
      allUnits: [sharedA],
      now,
    });
    tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sharedB],
      allUnits: [sharedA, sharedB],
      now: now + 1,
    });

    const decayed = tier.runLifecycle({
      sessionId: "session-c",
      sessionUnits: [],
      allUnits: [],
      now: now + DAY_MS + 10,
    });
    expect(decayed.decayed).toBe(1);

    const refreshed = tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [sharedB],
      allUnits: [sharedA, sharedB],
      now: now + DAY_MS + 20,
    });
    expect(refreshed.refreshed).toBe(1);

    const globals = tier.listUnits();
    expect(globals).toHaveLength(1);
    expect(globals[0]?.confidence).toBe(1);
  });

  test("pass lessons remove matching global fail lessons by lessonKey", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-pass-resolve-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const failA = unit({
      id: "fail-a",
      sessionId: "session-a",
      topic: "verification lessons",
      statement: "verification fail A",
      fingerprint: "fail-a-fp",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "fail",
      },
      updatedAt: now - 2,
    });
    const failB = unit({
      id: "fail-b",
      sessionId: "session-b",
      topic: "verification lessons",
      statement: "verification fail B",
      fingerprint: "fail-b-fp",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "fail",
      },
      updatedAt: now - 1,
    });
    tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: [failA],
      allUnits: [failA],
      now: now - 2,
    });
    tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: [failB],
      allUnits: [failA, failB],
      now: now - 1,
    });
    expect(tier.listUnits().length).toBe(1);
    expect(tier.listUnits()[0]?.metadata?.lessonOutcome).toBe("fail");

    const passC = unit({
      id: "pass-c",
      sessionId: "session-c",
      topic: "verification lessons",
      statement: "verification pass",
      fingerprint: "pass-c-fp",
      type: "learning",
      metadata: {
        lessonKey: "verification:standard:none:type-check+tests",
        lessonOutcome: "pass",
      },
      updatedAt: now,
    });
    const lifecycle = tier.runLifecycle({
      sessionId: "session-c",
      sessionUnits: [passC],
      allUnits: [failA, failB, passC],
      now,
    });

    expect(lifecycle.resolvedByPass).toBeGreaterThanOrEqual(1);
    const remainingFails = tier
      .listUnits()
      .filter((item) => item.metadata?.lessonOutcome === "fail");
    expect(remainingFails).toHaveLength(0);
  });

  test("compiles global crystals from recurring pattern units", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-crystal-"));
    const tier = new GlobalMemoryTier({
      rootDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const unitsA = [
      unit({
        id: "u-a1",
        sessionId: "session-a",
        topic: "verification lessons",
        statement: "verification fail profile A",
        fingerprint: "fp-a",
        type: "learning",
        metadata: {
          pattern: "verification:standard:none",
          lessonOutcome: "fail",
          rootCause: "failed checks: tests",
          recommendation: "run type-check before tests",
        },
        updatedAt: now - 10,
      }),
      unit({
        id: "u-a2",
        sessionId: "session-a",
        topic: "verification lessons",
        statement: "verification fail profile B",
        fingerprint: "fp-b",
        type: "learning",
        metadata: {
          pattern: "verification:standard:none",
          lessonOutcome: "fail",
          rootCause: "missing evidence: test_or_build",
          recommendation: "capture test evidence in ledger",
        },
        updatedAt: now - 9,
      }),
    ];
    tier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: unitsA,
      allUnits: unitsA,
      now: now - 9,
    });

    const unitsB = [
      unit({
        id: "u-b1",
        sessionId: "session-b",
        topic: "verification lessons",
        statement: "verification fail profile A",
        fingerprint: "fp-a",
        type: "learning",
        metadata: {
          pattern: "verification:standard:none",
          lessonOutcome: "fail",
          rootCause: "failed checks: tests",
          recommendation: "run type-check before tests",
        },
        updatedAt: now - 2,
      }),
      unit({
        id: "u-b2",
        sessionId: "session-b",
        topic: "verification lessons",
        statement: "verification fail profile B",
        fingerprint: "fp-b",
        type: "learning",
        metadata: {
          pattern: "verification:standard:none",
          lessonOutcome: "fail",
          rootCause: "missing evidence: test_or_build",
          recommendation: "capture test evidence in ledger",
        },
        updatedAt: now - 1,
      }),
    ];
    const lifecycle = tier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: unitsB,
      allUnits: [...unitsA, ...unitsB],
      now,
    });
    expect(lifecycle.crystalsCompiled).toBeGreaterThan(0);

    const crystals = tier.listCrystals();
    expect(crystals.length).toBeGreaterThan(0);
    expect(crystals[0]?.topic.includes("global pattern")).toBe(true);
    expect(crystals[0]?.summary.includes("[GlobalCrystal]")).toBe(true);
    const protocol = crystals[0]?.metadata?.globalCrystal as
      | {
          schema?: string;
          version?: number;
          pattern?: string;
          patterns?: string[];
          rootCause?: string;
          rootCauses?: string[];
          recommendation?: string;
          recommendations?: string[];
          outcomes?: { pass?: number; fail?: number };
          sourceSessionIds?: string[];
          sourceSessionCount?: number;
          unitCount?: number;
        }
      | undefined;
    expect(protocol?.schema).toBe("brewva.memory.global-crystal.v1");
    expect(protocol?.version).toBe(1);
    expect(protocol?.pattern).toBe("verification:standard:none");
    expect(protocol?.patterns).toEqual(["verification:standard:none"]);
    expect(protocol?.rootCause).toBe("missing evidence: test_or_build");
    expect(protocol?.rootCauses).toEqual([
      "missing evidence: test_or_build",
      "failed checks: tests",
    ]);
    expect(protocol?.recommendation).toBe("capture test evidence in ledger");
    expect(protocol?.recommendations).toEqual([
      "capture test evidence in ledger",
      "run type-check before tests",
    ]);
    expect(protocol?.outcomes).toEqual({ pass: 0, fail: 4 });
    expect(Array.isArray(protocol?.sourceSessionIds)).toBe(true);
    expect(protocol?.sourceSessionCount).toBe(2);
    expect(protocol?.unitCount).toBe(2);
  });

  test("imports global snapshot with units and crystals", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-snapshot-source-"));
    const sourceTier = new GlobalMemoryTier({
      rootDir: sourceDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });

    const now = Date.now();
    const sessionA = [
      unit({
        id: "u-a1",
        sessionId: "session-a",
        topic: "verification lessons",
        statement: "verification fail profile A",
        fingerprint: "snap-fp-a",
        metadata: { pattern: "verification:standard:none", lessonOutcome: "fail" },
        updatedAt: now - 20,
      }),
      unit({
        id: "u-a2",
        sessionId: "session-a",
        topic: "verification lessons",
        statement: "verification fail profile B",
        fingerprint: "snap-fp-b",
        metadata: { pattern: "verification:standard:none", lessonOutcome: "fail" },
        updatedAt: now - 19,
      }),
    ];
    sourceTier.runLifecycle({
      sessionId: "session-a",
      sessionUnits: sessionA,
      allUnits: sessionA,
      now: now - 19,
    });

    const sessionB = [
      unit({
        id: "u-b1",
        sessionId: "session-b",
        topic: "verification lessons",
        statement: "verification fail profile A",
        fingerprint: "snap-fp-a",
        metadata: { pattern: "verification:standard:none", lessonOutcome: "fail" },
        updatedAt: now - 2,
      }),
      unit({
        id: "u-b2",
        sessionId: "session-b",
        topic: "verification lessons",
        statement: "verification fail profile B",
        fingerprint: "snap-fp-b",
        metadata: { pattern: "verification:standard:none", lessonOutcome: "fail" },
        updatedAt: now - 1,
      }),
    ];
    sourceTier.runLifecycle({
      sessionId: "session-b",
      sessionUnits: sessionB,
      allUnits: [...sessionA, ...sessionB],
      now,
    });

    const snapshot = sourceTier.snapshot();
    expect(snapshot.units.length).toBeGreaterThan(0);
    expect(snapshot.crystals.length).toBeGreaterThan(0);

    const targetDir = mkdtempSync(join(tmpdir(), "brewva-memory-global-snapshot-target-"));
    const targetTier = new GlobalMemoryTier({
      rootDir: targetDir,
      promotionMinConfidence: 0.8,
      promotionMinSessionRecurrence: 2,
      decayIntervalDays: 7,
      decayFactor: 0.95,
      pruneBelowConfidence: 0.3,
    });
    const imported = targetTier.importSnapshot(snapshot);
    expect(imported.importedUnits).toBe(snapshot.units.length);
    expect(imported.importedCrystals).toBe(snapshot.crystals.length);
    expect(targetTier.listUnits().length).toBe(snapshot.units.length);
    expect(targetTier.listCrystals().length).toBe(snapshot.crystals.length);
    expect(targetTier.listUnits()[0]?.sessionId).toBe(GLOBAL_MEMORY_SESSION_ID);
  });
});
