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
});
