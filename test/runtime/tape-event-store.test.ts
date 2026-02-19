import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROASTER_CONFIG,
  RoasterEventStore,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
} from "@pi-roaster/roaster-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `roaster-${name}-`));
}

describe("RoasterEventStore tape helpers", () => {
  test("writes and queries anchor/checkpoint events via dedicated methods", () => {
    const workspace = createWorkspace("tape-store");
    const store = new RoasterEventStore(
      DEFAULT_ROASTER_CONFIG.infrastructure.events,
      workspace,
    );
    const sessionId = "tape-store-1";

    store.appendAnchor({
      sessionId,
      payload: buildTapeAnchorPayload({
        name: "investigation-done",
        summary: "root cause isolated",
        nextSteps: "apply patch",
      }),
      turn: 3,
    });
    store.appendCheckpoint({
      sessionId,
      payload: buildTapeCheckpointPayload({
        taskState: {
          items: [],
          blockers: [],
          updatedAt: null,
        },
        truthState: {
          facts: [],
          updatedAt: null,
        },
        reason: "unit_test",
      }),
      turn: 3,
    });

    const anchors = store.listAnchors(sessionId);
    const checkpoints = store.listCheckpoints(sessionId);
    expect(anchors).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    expect(anchors[0]?.type).toBe("anchor");
    expect(checkpoints[0]?.type).toBe("checkpoint");
  });
});
