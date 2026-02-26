import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, buildTruthFactUpsertedEvent } from "@brewva/brewva-runtime";

describe("session state cleanup", () => {
  test("clearSessionState releases in-memory per-session caches", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-session-clean-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "cleanup-state-1";

    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.context.observeUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.tools.acquireParallelSlot(sessionId, "run-1");
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "run-1",
      status: "ok",
      summary: "done",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "diff" }],
      },
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      success: true,
    });
    runtime.task.getState(sessionId);
    runtime.truth.getState(sessionId);
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0001,
    });

    const sessionState = (runtime as any).sessionState as {
      turnsBySession: Map<string, number>;
      toolCallsBySession: Map<string, number>;
    };
    expect(sessionState.turnsBySession.has(sessionId)).toBe(true);
    expect(sessionState.toolCallsBySession.has(sessionId)).toBe(true);
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      true,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      true,
    );
    expect(
      ((runtime as any).verificationGate.stateStore.sessions as Map<string, unknown>).has(
        sessionId,
      ),
    ).toBe(true);
    expect(((runtime as any).eventStore.fileHasContent as Map<string, boolean>).size).toBe(1);
    expect((runtime as any).ledger.lastHashBySession.has(sessionId) as boolean).toBe(true);

    runtime.session.clearState(sessionId);

    expect(sessionState.turnsBySession.has(sessionId)).toBe(false);
    expect(sessionState.toolCallsBySession.has(sessionId)).toBe(false);
    expect((runtime as any).turnReplay.hasSession(sessionId)).toBe(false);
    expect(((runtime as any).contextBudget.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).costTracker.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(
      ((runtime as any).verificationGate.stateStore.sessions as Map<string, unknown>).has(
        sessionId,
      ),
    ).toBe(false);
    expect(((runtime as any).parallel.sessions as Map<string, unknown>).has(sessionId)).toBe(false);
    expect(((runtime as any).parallelResults.sessions as Map<string, unknown>).has(sessionId)).toBe(
      false,
    );
    expect(((runtime as any).eventStore.fileHasContent as Map<string, boolean>).size).toBe(0);
    expect((runtime as any).ledger.lastHashBySession.has(sessionId) as boolean).toBe(false);
  });

  test("keeps replay cache hot and incrementally updates task replay view", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-replay-view-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-view-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay view should rebuild after new events",
    });
    runtime.task.getState(sessionId);

    const turnReplay = (runtime as any).turnReplay as {
      hasSession: (session: string) => boolean;
    };
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.task.addItem(sessionId, { text: "item-1" });
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    const updated = runtime.task.getState(sessionId);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.text).toBe("item-1");
    expect(turnReplay.hasSession(sessionId)).toBe(true);
  });

  test("keeps replay cache for non-folding events and incrementally folds truth updates", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-replay-filter-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-filter-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay cache should ignore non-folding events",
    });
    runtime.task.getState(sessionId);

    const turnReplay = (runtime as any).turnReplay as {
      hasSession: (session: string) => boolean;
    };
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.events.record({
      sessionId,
      type: "tool_call",
      payload: {
        toolCallId: "tc-1",
        toolName: "look_at",
      },
    });
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    runtime.events.record({
      sessionId,
      type: "truth_event",
      payload: buildTruthFactUpsertedEvent({
        id: "truth-1",
        kind: "test",
        status: "active",
        severity: "warn",
        summary: "truth update",
        evidenceIds: ["led-1"],
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      }) as unknown as Record<string, unknown>,
    });
    expect(turnReplay.hasSession(sessionId)).toBe(true);

    const truthState = runtime.truth.getState(sessionId);
    expect(truthState.facts).toHaveLength(1);
    expect(truthState.facts[0]?.id).toBe("truth-1");
    expect(turnReplay.hasSession(sessionId)).toBe(true);
  });
});
