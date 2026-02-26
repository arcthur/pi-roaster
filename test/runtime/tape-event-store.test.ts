import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaEventStore,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-${name}-`));
}

describe("BrewvaEventStore tape helpers", () => {
  test("writes and queries anchor/checkpoint events via dedicated methods", () => {
    const workspace = createWorkspace("tape-store");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
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
        costSummary: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
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
          totalRecords: 0,
          failureRecords: 0,
          anchorEpoch: 0,
          recentFailures: [],
        },
        memoryState: {
          updatedAt: null,
          crystals: [],
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

  test("keeps incremental cache synchronized for external append and file truncation", () => {
    const workspace = createWorkspace("tape-store-incremental");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-incremental-1";
    const first = store.append({
      sessionId,
      type: "session_start",
      payload: { source: "test" },
      timestamp: 100,
    });
    expect(first).toBeDefined();
    expect(store.list(sessionId)).toHaveLength(1);

    const eventsDir = DEFAULT_BREWVA_CONFIG.infrastructure.events.dir;
    const eventFilePath = join(workspace, eventsDir, `${sessionId}.jsonl`);
    const externalRow = {
      id: "evt_external_1",
      sessionId,
      type: "tool_call",
      timestamp: 101,
      payload: { toolName: "look_at" },
    };
    writeFileSync(eventFilePath, `\n${JSON.stringify(externalRow)}`, { flag: "a" });

    const afterExternalAppend = store.list(sessionId);
    expect(afterExternalAppend).toHaveLength(2);
    expect(afterExternalAppend[1]?.id).toBe("evt_external_1");

    const rewrittenRow = {
      id: "evt_rewritten_1",
      sessionId,
      type: "session_restart",
      timestamp: 102,
      payload: { reason: "manual-truncate" },
    };
    writeFileSync(eventFilePath, JSON.stringify(rewrittenRow), "utf8");

    const afterTruncate = store.list(sessionId);
    expect(afterTruncate).toHaveLength(1);
    expect(afterTruncate[0]?.id).toBe("evt_rewritten_1");
  });

  test("generates unique event ids for high-frequency appends", () => {
    const workspace = createWorkspace("tape-store-id");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-id-1";

    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const row = store.append({
        sessionId,
        type: "test_event",
        payload: { index },
        timestamp: 1735689600000,
      });
      expect(row).toBeDefined();
      if (!row) continue;
      ids.add(row.id);
    }

    expect(ids.size).toBe(200);
    for (const id of ids.values()) {
      expect(id.startsWith("evt_1735689600000_")).toBe(true);
    }
  });
});
