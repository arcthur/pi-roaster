import { describe, expect, test } from "bun:test";
import {
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  extractMemoryFromEvent,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";

function event(input: {
  id: string;
  type: string;
  sessionId?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "mem-extractor-session",
    type: input.type,
    timestamp: input.timestamp ?? 1_700_000_000_000,
    payload: input.payload as BrewvaEventRecord["payload"],
  };
}

describe("memory extractor", () => {
  test("extracts truth upsert into memory unit candidate", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-truth-upsert",
        type: TRUTH_EVENT_TYPE,
        payload: {
          schema: "brewva.truth.ledger.v1",
          kind: "fact_upserted",
          fact: {
            id: "truth:command:1",
            kind: "command_failure",
            status: "active",
            severity: "error",
            summary: "command failed: bun test",
            evidenceIds: ["ev-1"],
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_000_001,
          },
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.type).toBe("risk");
    expect(result.upserts[0]?.metadata?.truthFactId).toBe("truth:command:1");
    expect(result.resolves).toHaveLength(0);
  });

  test("extracts task blocker_resolved into resolve directive", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-resolved",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "blocker_resolved",
          blockerId: "blocker-1",
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toEqual([
      {
        sessionId: "mem-extractor-session",
        sourceType: "task_blocker",
        sourceId: "blocker-1",
        resolvedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("extracts skill_completed into learning unit", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-skill-completed",
        type: "skill_completed",
        payload: {
          skillName: "debugging",
          outputKeys: ["root_cause", "verification"],
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.type).toBe("learning");
    expect(result.upserts[0]?.topic).toContain("debugging");
  });

  test("promotes verification status_set into memory signal candidate", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-status-verification",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "status_set",
          status: {
            phase: "done",
            health: "ok",
            reason: "verification_passed",
            updatedAt: 1_700_000_000_500,
          },
        },
      }),
    );

    const verificationUnit = result.upserts.find(
      (candidate) => candidate.metadata?.memorySignal === "verification",
    );
    expect(verificationUnit).toBeDefined();
    expect(verificationUnit?.type).toBe("learning");
    expect(verificationUnit?.topic).toBe("verification");
    expect(verificationUnit?.status).toBe("resolved");
  });

  test("verification_state_reset resolves verification-related memory units", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-verification-reset",
        type: "verification_state_reset",
        payload: {
          reason: "rollback",
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toEqual([
      {
        sessionId: "mem-extractor-session",
        sourceType: "memory_signal",
        sourceId: "verification",
        resolvedAt: 1_700_000_000_000,
      },
      {
        sessionId: "mem-extractor-session",
        sourceType: "task_kind",
        sourceId: "status_set",
        resolvedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("extracts verification_outcome_recorded into verification lessons", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-verification-outcome",
        type: "verification_outcome_recorded",
        payload: {
          schema: "brewva.verification.outcome.v1",
          level: "standard",
          outcome: "fail",
          strategy: "verification_level=standard; checks=tests:fail",
          failedChecks: ["tests"],
          missingEvidence: ["tests"],
          evidence: "tests: exitCode=1",
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.type).toBe("learning");
    expect(result.upserts[0]?.topic).toBe("verification lessons");
    expect(result.upserts[0]?.metadata?.memorySignal).toBe("verification_outcome_fail");
    expect(typeof result.upserts[0]?.metadata?.lessonKey).toBe("string");
    expect(result.upserts[0]?.metadata?.lessonOutcome).toBe("fail");
    expect(typeof result.upserts[0]?.metadata?.pattern).toBe("string");
    expect(result.upserts[0]?.status).toBe("active");
    expect(result.resolves).toHaveLength(0);
  });

  test("verification_outcome_recorded pass resolves fail lessons by lesson key", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-verification-outcome-pass",
        type: "verification_outcome_recorded",
        payload: {
          schema: "brewva.verification.outcome.v1",
          level: "standard",
          outcome: "pass",
          lessonKey: "verification:standard:none:type-check+tests",
          strategy: "verification_level=standard",
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.metadata?.memorySignal).toBe("verification_outcome_pass");
    expect(result.upserts[0]?.metadata?.lessonOutcome).toBe("pass");
    expect(result.resolves).toEqual([
      {
        sessionId: "mem-extractor-session",
        sourceType: "lesson_key",
        sourceId: "verification:standard:none:type-check+tests",
        resolvedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("extracts cognitive_outcome_reflection into lesson units", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-cognitive-reflection",
        type: "cognitive_outcome_reflection",
        payload: {
          stage: "verification_outcome",
          lesson: "Prefer running type-check before full test suite.",
          adjustedStrategy: "Run type-check first, then focused tests.",
          outcome: "fail",
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.type).toBe("learning");
    expect(result.upserts[0]?.topic).toBe("lessons learned");
    expect(result.upserts[0]?.metadata?.memorySignal).toBe("lesson");
    expect(result.upserts[0]?.metadata?.lessonOutcome).toBe("fail");
    expect(
      result.upserts[0]?.statement.includes(
        "Recommendation: Run type-check first, then focused tests.",
      ),
    ).toBe(true);
  });

  test("extracts preference units from soft constraints", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-preference",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "spec_set",
          spec: {
            schema: "brewva.task.v1",
            goal: "Implement memory improvements",
            constraints: ["Prefer Bun-native tooling for local scripts."],
          },
        },
      }),
    );

    const preference = result.upserts.find((candidate) => candidate.type === "preference");
    expect(preference).toBeDefined();
    expect(preference?.topic).toBe("preference");
  });

  test("extracts hypothesis units from uncertain blockers", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-hypothesis",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "blocker_recorded",
          blocker: {
            id: "blocker-h1",
            message: "This might be caused by stale context injection ordering.",
          },
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.type).toBe("hypothesis");
    expect(result.upserts[0]?.topic).toBe("hypothesis");
  });
});
