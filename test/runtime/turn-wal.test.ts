import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { TurnWALStore, type TurnEnvelope } from "@brewva/brewva-runtime/channels";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-turn-wal-${name}-`));
}

function createEnvelope(id: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: id,
    channel: "telegram",
    conversationId: "conversation-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: `prompt ${id}` }],
  };
}

describe("turn wal store", () => {
  test("appends transitions and derives pending records from latest status", () => {
    const workspace = createWorkspace("status");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    expect(pending.status).toBe("pending");
    expect(pending.attempts).toBe(0);
    expect(store.listPending().map((row) => row.walId)).toEqual([pending.walId]);

    const inflight = store.markInflight(pending.walId);
    expect(inflight?.status).toBe("inflight");
    expect(inflight?.attempts).toBe(1);

    const done = store.markDone(pending.walId);
    expect(done?.status).toBe("done");
    expect(store.listPending()).toHaveLength(0);

    const lines = readFileSync(store.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.length).toBe(3);
  });

  test("compacts terminal records older than retention window", () => {
    const workspace = createWorkspace("compact");
    let nowMs = 10_000;
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: {
        ...DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
        compactAfterMs: 100,
      },
      scope: "gateway",
      now: () => nowMs,
    });

    const row = store.appendPending(createEnvelope("turn-compact"), "gateway");
    store.markInflight(row.walId);
    store.markDone(row.walId);

    nowMs += 500;
    const compacted = store.compact();
    expect(compacted.scanned).toBe(1);
    expect(compacted.dropped).toBe(1);
    expect(store.listCurrent()).toHaveLength(0);
  });

  test("keeps append order and unique wal ids under burst appends", async () => {
    const workspace = createWorkspace("burst");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "burst",
    });

    const rows = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        Promise.resolve().then(() =>
          store.appendPending(createEnvelope(`turn-${index}`), "channel"),
        ),
      ),
    );
    const walIds = rows.map((row) => row.walId);
    expect(new Set(walIds).size).toBe(rows.length);
    expect(store.listPending()).toHaveLength(40);
  });
});
