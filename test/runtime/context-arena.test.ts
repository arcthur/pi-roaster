import { describe, expect, test } from "bun:test";
import { ContextArena } from "@brewva/brewva-runtime";

describe("ContextArena", () => {
  const sessionId = "context-arena-session";

  test("append keeps historical entries (append-only)", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact v1",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact v2",
      priority: "critical",
    });

    const snapshot = arena.snapshot(sessionId);
    expect(snapshot.totalAppended).toBe(2);
    expect(snapshot.activeKeys).toBe(1);
  });

  test("plan uses latest value per key (last-write-wins)", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "old fact",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "new fact",
      priority: "critical",
    });

    const plan = arena.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("new fact");
  });

  test("markPresented keeps stored entries and suppresses next plan", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
      priority: "critical",
    });

    const first = arena.plan(sessionId, 10_000);
    expect(first.entries).toHaveLength(1);
    arena.markPresented(sessionId, first.consumedKeys);
    const snapshot = arena.snapshot(sessionId);
    expect(snapshot.totalAppended).toBe(1);

    const second = arena.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("oncePerSession prevents re-append after presentation", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity",
      priority: "critical",
      oncePerSession: true,
    });
    const first = arena.plan(sessionId, 10_000);
    arena.markPresented(sessionId, first.consumedKeys);

    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity-v2",
      priority: "critical",
      oncePerSession: true,
    });
    const second = arena.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("plan orders by priority before timestamp", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      content: "memory",
      priority: "normal",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "task",
      priority: "high",
    });

    const planned = arena.plan(sessionId, 10_000);
    const sources = planned.entries.map((entry) => entry.source);
    expect(sources).toEqual(["brewva.truth-facts", "brewva.task-state", "brewva.memory-working"]);
  });

  test("clearSession clears the whole session arena", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
      priority: "critical",
    });

    arena.clearSession(sessionId);
    const plan = arena.plan(sessionId, 10_000);
    const snapshot = arena.snapshot(sessionId);
    expect(plan.entries).toHaveLength(0);
    expect(snapshot.totalAppended).toBe(0);
  });

  test("trims superseded history under long-session append pressure", () => {
    const arena = new ContextArena();
    const hotSession = "context-arena-hot-session";

    for (let i = 0; i < 2_500; i += 1) {
      arena.append(hotSession, {
        source: "brewva.truth-facts",
        id: "truth-facts",
        content: `fact-${i}`,
        priority: "critical",
      });
    }

    const snapshot = arena.snapshot(hotSession);
    expect(snapshot.totalAppended).toBeLessThan(1_000);
    expect(snapshot.activeKeys).toBe(1);

    const plan = arena.plan(hotSession, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.content).toBe("fact-2499");
  });

  test("drop_recall policy drops incoming recall entry at SLO ceiling", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
      priority: "critical",
    });
    const dropped = arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall",
      content: "recall",
      priority: "normal",
    });
    expect(dropped.accepted).toBe(false);
    expect(dropped.sloEnforced?.dropped).toBe(true);
  });

  test("drop_recall policy prefers fresher incoming recall by evicting older recall entries", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
    });
    arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall",
      content: "old-recall",
      priority: "normal",
    });
    const result = arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall-next",
      content: "new-recall",
      priority: "normal",
    });
    expect(result.accepted).toBe(true);
    expect(result.sloEnforced?.dropped).toBe(false);

    const plan = arena.plan(sessionId, 500);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.id).toBe("memory-recall-next");
    expect(plan.entries[0]?.content).toBe("new-recall");
  });

  test("snapshot exposes append-only arena counters", () => {
    const snapshotSessionId = "context-arena-snapshot";
    const arena = new ContextArena({
      truncationStrategy: "drop-entry",
      maxEntriesPerSession: 64,
    });
    arena.append(snapshotSessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(2_000),
      priority: "critical",
    });
    arena.append(snapshotSessionId, {
      source: "brewva.rag-external",
      id: "rag-external",
      content: "r".repeat(800),
      priority: "normal",
    });

    arena.plan(snapshotSessionId, 421);
    const snapshot = arena.snapshot(snapshotSessionId);

    expect(snapshot.totalAppended).toBe(2);
    expect(snapshot.activeKeys).toBe(2);
    expect(snapshot.onceKeys).toBe(0);
  });
});
