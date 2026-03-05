import { describe, expect, test } from "bun:test";
import { buildTapeCheckpointPayload, coerceTapeCheckpointPayload } from "@brewva/brewva-runtime";

function buildValidCheckpointPayload() {
  return buildTapeCheckpointPayload({
    taskState: {
      items: [
        {
          id: "item-1",
          text: "task item",
          status: "todo",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      blockers: [
        {
          id: "blk-1",
          message: "blocked",
          createdAt: 2,
        },
      ],
      updatedAt: 3,
    },
    truthState: {
      facts: [
        {
          id: "fact-1",
          kind: "test",
          status: "active",
          severity: "warn",
          summary: "truth summary",
          evidenceIds: ["led-1"],
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ],
      updatedAt: 3,
    },
    costSummary: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      totalCostUsd: 0.002,
      models: {},
      skills: {},
      tools: {},
      alerts: [],
      budget: {
        action: "warn",
        sessionExceeded: false,
        blocked: false,
      },
    },
    evidenceState: {
      totalRecords: 1,
      failureRecords: 0,
      anchorEpoch: 0,
      recentFailures: [],
    },
    memoryState: {
      updatedAt: 3,
      unitCount: 0,
    },
    reason: "unit_test",
    createdAt: 10,
  });
}

describe("tape checkpoint payload coercion", () => {
  test("given valid checkpoint payload, when coercing payload, then payload is accepted", () => {
    const payload = buildValidCheckpointPayload();
    expect(coerceTapeCheckpointPayload(payload)).not.toBeNull();
  });

  test("given legacy checkpoint payload without failure class counts, when coercing payload, then defaults are populated", () => {
    const payload = buildValidCheckpointPayload();
    if (!payload.state.evidence) {
      throw new Error("expected evidence state");
    }
    delete (payload.state.evidence as { failureClassCounts?: unknown }).failureClassCounts;
    payload.state.evidence.failureRecords = 3;

    const coerced = coerceTapeCheckpointPayload(payload);
    expect(coerced).not.toBeNull();
    expect(coerced?.state.evidence.failureClassCounts).toEqual({
      execution: 3,
      invocation_validation: 0,
      shell_syntax: 0,
      script_composition: 0,
    });
  });

  test("given checkpoint payload with invalid task.items, when coercing payload, then payload is rejected", () => {
    const payload = buildValidCheckpointPayload() as unknown as {
      state: { task: { items: unknown } };
    };
    payload.state.task.items = { invalid: true };
    expect(coerceTapeCheckpointPayload(payload)).toBeNull();
  });

  test("given checkpoint payload with invalid truth fact structure, when coercing payload, then payload is rejected", () => {
    const payload = buildValidCheckpointPayload() as unknown as {
      state: {
        truth: {
          facts: Array<Record<string, unknown>>;
        };
      };
    };
    const first = payload.state.truth.facts[0];
    if (!first) throw new Error("expected truth fact");
    delete first.evidenceIds;
    expect(coerceTapeCheckpointPayload(payload)).toBeNull();
  });

  test("given checkpoint payload with unknown task phase, when coercing payload, then payload is rejected", () => {
    const payload = buildValidCheckpointPayload() as unknown as {
      state: {
        task: {
          status?: Record<string, unknown>;
        };
      };
    };
    payload.state.task.status = {
      phase: "unknown_phase",
      health: "ok",
      updatedAt: 9,
    };
    expect(coerceTapeCheckpointPayload(payload)).toBeNull();
  });

  test("given checkpoint payload missing extended state fields, when coercing payload, then payload is rejected", () => {
    const payload = buildValidCheckpointPayload() as unknown as {
      state: {
        cost?: unknown;
        evidence?: unknown;
        memory?: unknown;
        costSkillLastTurnByName?: unknown;
      };
    };
    delete payload.state.cost;
    delete payload.state.costSkillLastTurnByName;
    delete payload.state.evidence;
    delete payload.state.memory;

    expect(coerceTapeCheckpointPayload(payload)).toBeNull();
  });

  test("given checkpoint payload with legacy memory crystals, when coercing payload, then payload is rejected", () => {
    const payload = buildValidCheckpointPayload() as unknown as {
      state: {
        memory: {
          updatedAt: number | null;
          unitCount?: number;
          crystals?: unknown[];
        };
      };
    };
    payload.state.memory = {
      updatedAt: 3,
      crystals: [],
    };
    expect(coerceTapeCheckpointPayload(payload)).toBeNull();
  });
});
