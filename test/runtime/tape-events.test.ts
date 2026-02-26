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
        skillExceeded: false,
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
      crystals: [],
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

  test("given legacy checkpoint payload missing extended state fields, when coercing payload, then defaults are applied", () => {
    const payload = buildValidCheckpointPayload() as unknown as {
      state: {
        cost?: unknown;
        evidence?: unknown;
        memory?: unknown;
      };
    };
    delete payload.state.cost;
    delete payload.state.evidence;
    delete payload.state.memory;

    const coerced = coerceTapeCheckpointPayload(payload);
    expect(coerced).not.toBeNull();
    expect(coerced?.state.cost.totalTokens).toBe(0);
    expect(coerced?.state.costSkillLastTurnByName).toEqual({});
    expect(coerced?.state.evidence.totalRecords).toBe(0);
    expect(coerced?.state.memory.crystals).toHaveLength(0);
  });
});
