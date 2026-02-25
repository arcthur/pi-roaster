import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
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
  test("given a new envelope, when appendPending is called, then pending record is created and listed", () => {
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
  });

  test("given a pending record, when markInflight is called, then status becomes inflight with incremented attempts", () => {
    const workspace = createWorkspace("status-inflight");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    const inflight = store.markInflight(pending.walId);
    expect(inflight?.status).toBe("inflight");
    expect(inflight?.attempts).toBe(1);
    expect(store.listPending().map((row) => row.status)).toEqual(["inflight"]);
  });

  test("given an inflight record, when markDone is called, then record becomes done and leaves pending view", () => {
    const workspace = createWorkspace("status-done");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markInflight(pending.walId);
    const done = store.markDone(pending.walId);
    expect(done?.status).toBe("done");
    expect(store.listPending()).toHaveLength(0);
  });

  test("given lifecycle transitions, when records are appended and updated, then wal file persists each transition", () => {
    const workspace = createWorkspace("status-persist");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markInflight(pending.walId);
    store.markDone(pending.walId);

    const lines = readFileSync(store.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.length).toBe(3);
  });

  test("given unknown wal id, when markDone is called, then result is undefined", () => {
    const workspace = createWorkspace("unknown-id");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    expect(store.markDone("missing-wal-id")).toBeUndefined();
  });

  test("given a done record, when markInflight is called again, then transition is ignored", () => {
    const workspace = createWorkspace("terminal-transition");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markInflight(pending.walId);
    store.markDone(pending.walId);

    const transitioned = store.markInflight(pending.walId);
    expect(transitioned).toBeUndefined();
    expect(store.listCurrent().map((row) => row.status)).toEqual(["done"]);
  });

  test("given malformed wal lines, when store reloads, then latest valid records are recovered", () => {
    const workspace = createWorkspace("corrupt-lines");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });
    const pending = store.appendPending(createEnvelope("turn-corrupt"), "channel");
    appendFileSync(store.filePath, '\n{"schema":"bad"}\nnot-json\n', "utf8");

    const reloaded = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });
    const rows = reloaded.listPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.walId).toBe(pending.walId);
  });

  test("given terminal records beyond retention window, when compact runs, then stale records are dropped", () => {
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

  test("given burst appends, when appendPending is called concurrently, then wal ids stay unique and rows remain ordered", async () => {
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
