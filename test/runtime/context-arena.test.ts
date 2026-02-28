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

  test("zoneLayout orders entries by zone before priority", () => {
    const arena = new ContextArena({ zoneLayout: true });
    arena.append(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      content: "memory",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
      priority: "normal",
    });
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity",
      priority: "low",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "task",
      priority: "high",
    });

    const planned = arena.plan(sessionId, 10_000);
    const sources = planned.entries.map((entry) => entry.source);
    expect(sources).toEqual([
      "brewva.identity",
      "brewva.truth-facts",
      "brewva.task-state",
      "brewva.memory-working",
    ]);
  });

  test("resetEpoch clears the whole session arena", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "fact",
      priority: "critical",
    });

    arena.resetEpoch(sessionId);
    const plan = arena.plan(sessionId, 10_000);
    const snapshot = arena.snapshot(sessionId);
    expect(plan.entries).toHaveLength(0);
    expect(snapshot.totalAppended).toBe(0);
  });

  test("plan returns floor_unmet when zone floors exceed total budget", () => {
    const arena = new ContextArena({
      zoneLayout: true,
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 500, max: 1000 },
        task_state: { min: 500, max: 1000 },
        tool_failures: { min: 0, max: 240 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 0, max: 600 },
        rag_external: { min: 0, max: 0 },
      },
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(2_500),
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "s".repeat(2_500),
      priority: "critical",
    });

    const planned = arena.plan(sessionId, 100);
    expect(planned.entries).toHaveLength(0);
    expect(planned.text).toBe("");
    expect(planned.planReason).toBe("floor_unmet");
  });

  test("forceCriticalOnly filters to identity/truth/task_state zones", () => {
    const arena = new ContextArena();
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      content: "identity",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      content: "working",
      priority: "normal",
    });
    arena.append(sessionId, {
      source: "brewva.tool-failures",
      id: "tool-failures",
      content: "failure",
      priority: "high",
    });

    const normal = arena.plan(sessionId, 10_000);
    expect(normal.entries).toHaveLength(3);
    expect(normal.planTelemetry.stabilityForced).toBe(false);

    arena.clearPending(sessionId);
    const forced = arena.plan(sessionId, 10_000, { forceCriticalOnly: true });
    expect(forced.entries).toHaveLength(1);
    expect(forced.entries[0]?.source).toBe("brewva.identity");
    expect(forced.planTelemetry.stabilityForced).toBe(true);
  });

  test("forceCriticalOnly bypasses floor_unmet even when critical floors exceed budget", () => {
    const arena = new ContextArena({
      zoneLayout: true,
      floorUnmetPolicy: {
        enabled: false,
        relaxOrder: [],
        finalFallback: "critical_only",
      },
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 96, max: 420 },
        task_state: { min: 32, max: 360 },
        tool_failures: { min: 0, max: 240 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 0, max: 600 },
        rag_external: { min: 0, max: 0 },
      },
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(1_000),
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-state",
      content: "task ".repeat(400),
      priority: "critical",
    });

    const normal = arena.plan(sessionId, 100);
    expect(normal.planReason).toBe("floor_unmet");

    arena.clearPending(sessionId);
    const forced = arena.plan(sessionId, 100, { forceCriticalOnly: true });
    expect(forced.planReason).toBeUndefined();
    expect(forced.entries.length).toBeGreaterThan(0);
    expect(forced.planTelemetry.stabilityForced).toBe(true);
    expect(forced.planTelemetry.floorUnmet).toBe(false);
  });

  test("hybrid strategy bypasses floor_unmet while preserving global token budget", () => {
    const arena = new ContextArena({
      zoneLayout: true,
      floorUnmetPolicy: {
        enabled: false,
        relaxOrder: [],
        finalFallback: "critical_only",
      },
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 96, max: 420 },
        task_state: { min: 96, max: 360 },
        tool_failures: { min: 0, max: 240 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 0, max: 600 },
        rag_external: { min: 0, max: 0 },
      },
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(2_000),
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-state",
      content: "task ".repeat(300),
      priority: "critical",
    });

    const managed = arena.plan(sessionId, 120);
    expect(managed.planReason).toBe("floor_unmet");

    arena.clearPending(sessionId);
    const hybrid = arena.plan(sessionId, 120, { strategyArm: "hybrid" });
    expect(hybrid.planReason).toBeUndefined();
    expect(hybrid.entries.length).toBeGreaterThan(0);
    expect(hybrid.estimatedTokens).toBeLessThanOrEqual(120);
    expect(hybrid.planTelemetry.strategyArm).toBe("hybrid");
    expect(hybrid.planTelemetry.adaptiveZonesDisabled).toBe(true);
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
      degradationPolicy: "drop_recall",
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
    expect(dropped.sloEnforced?.policy).toBe("drop_recall");
    expect(dropped.sloEnforced?.dropped).toBe(true);
  });

  test("drop_recall policy does not evict existing recall entries when incoming entry is also recall", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
      degradationPolicy: "drop_recall",
    });
    arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall",
      content: "old-recall",
      priority: "normal",
    });
    const dropped = arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall-next",
      content: "new-recall",
      priority: "normal",
    });
    expect(dropped.accepted).toBe(false);
    expect(dropped.sloEnforced?.policy).toBe("drop_recall");

    const plan = arena.plan(sessionId, 500);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.id).toBe("memory-recall");
    expect(plan.entries[0]?.content).toBe("old-recall");
  });

  test("drop_low_priority policy evicts low-priority active entry for critical append", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
      degradationPolicy: "drop_low_priority",
    });
    arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall",
      content: "recall",
      priority: "low",
    });
    const appended = arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth",
      priority: "critical",
    });
    expect(appended.accepted).toBe(true);
    expect(appended.sloEnforced?.policy).toBe("drop_low_priority");
    const plan = arena.plan(sessionId, 500);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.source).toBe("brewva.truth-facts");
  });

  test("force_compact policy clears active arena when ceiling is hit", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 1,
      degradationPolicy: "force_compact",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth-v1",
      priority: "critical",
    });
    const appended = arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-state",
      content: "task-v1",
      priority: "critical",
    });
    expect(appended.accepted).toBe(true);
    expect(appended.sloEnforced?.policy).toBe("force_compact");
    const plan = arena.plan(sessionId, 500);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.source).toBe("brewva.task-state");
  });

  test("recovers floor_unmet via configured floor relaxation cascade", () => {
    const arena = new ContextArena({
      zoneLayout: true,
      floorUnmetPolicy: {
        enabled: true,
        relaxOrder: ["memory_recall"],
        finalFallback: "critical_only",
      },
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 0, max: 420 },
        task_state: { min: 0, max: 360 },
        tool_failures: { min: 80, max: 240 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 80, max: 600 },
        rag_external: { min: 0, max: 0 },
      },
    });
    arena.append(sessionId, {
      source: "brewva.tool-failures",
      id: "tool-failures",
      content: "f".repeat(500),
      priority: "high",
    });
    arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "memory-recall",
      content: "r".repeat(500),
      priority: "normal",
    });

    const planned = arena.plan(sessionId, 100);
    expect(planned.planReason).toBeUndefined();
    expect(planned.entries.length).toBeGreaterThan(0);
    expect(planned.planTelemetry.floorUnmet).toBe(true);
    expect(planned.planTelemetry.appliedFloorRelaxation).toContain("memory_recall");
  });

  test("critical_only fallback keeps floor_unmet telemetry when recovery succeeds", () => {
    const arena = new ContextArena({
      zoneLayout: true,
      floorUnmetPolicy: {
        enabled: true,
        relaxOrder: [],
        finalFallback: "critical_only",
      },
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 0, max: 420 },
        task_state: { min: 0, max: 360 },
        tool_failures: { min: 80, max: 240 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 80, max: 600 },
        rag_external: { min: 0, max: 0 },
      },
    });
    arena.append(sessionId, {
      source: "brewva.tool-failures",
      id: "tool-failures",
      content: "f".repeat(300),
      priority: "high",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "truth-fact",
      priority: "critical",
    });

    const planned = arena.plan(sessionId, 20);
    expect(planned.planReason).toBeUndefined();
    expect(planned.entries.some((entry) => entry.source === "brewva.truth-facts")).toBe(true);
    expect(planned.entries.some((entry) => entry.source === "brewva.tool-failures")).toBe(false);
    expect(planned.planTelemetry.floorUnmet).toBe(true);
  });

  test("snapshot exposes adaptive controller EMA state", () => {
    const adaptiveSessionId = "context-arena-adaptive-snapshot";
    const arena = new ContextArena({
      zoneLayout: true,
      truncationStrategy: "drop-entry",
      zoneBudgets: {
        identity: { min: 0, max: 320 },
        truth: { min: 0, max: 420 },
        task_state: { min: 0, max: 360 },
        tool_failures: { min: 0, max: 480 },
        memory_working: { min: 0, max: 300 },
        memory_recall: { min: 0, max: 600 },
        rag_external: { min: 1, max: 160 },
      },
      adaptiveZones: {
        enabled: true,
        emaAlpha: 1,
        minTurnsBeforeAdapt: 8,
        stepTokens: 32,
        maxShiftPerTurn: 96,
        upshiftTruncationRatio: 0.25,
        downshiftIdleRatio: 0.15,
      },
    });
    arena.append(adaptiveSessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      content: "t".repeat(2_000),
      priority: "critical",
    });
    arena.append(adaptiveSessionId, {
      source: "brewva.rag-external",
      id: "rag-external",
      content: "r".repeat(800),
      priority: "normal",
    });

    arena.plan(adaptiveSessionId, 421);
    const snapshot = arena.snapshot(adaptiveSessionId);

    expect(snapshot.adaptiveController).not.toBeNull();
    expect(snapshot.adaptiveController?.turn).toBe(1);
    expect(snapshot.adaptiveController?.emaTruncationByZone.truth).toBeGreaterThan(0);
    expect(snapshot.adaptiveController?.emaIdleByZone.rag_external).toBeGreaterThan(0);
    expect(snapshot.adaptiveController?.maxByZone.truth).toBe(420);
  });
});
