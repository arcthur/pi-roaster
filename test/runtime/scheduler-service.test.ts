import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SchedulerService,
  type SchedulerRuntimePort,
  buildScheduleIntentCancelledEvent,
  buildScheduleIntentCreatedEvent,
  parseScheduleIntentEvent,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-scheduler-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("scheduler service", () => {
  test("accepts SchedulerRuntimePort without direct BrewvaRuntime coupling", async () => {
    const workspace = createWorkspace("runtime-port");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-runtime-port-session";
    const now = Date.now();

    const runtimePort: SchedulerRuntimePort = {
      workspaceRoot: runtime.workspaceRoot,
      scheduleConfig: runtime.config.schedule,
      listSessionIds: () => runtime.events.listSessionIds(),
      listEvents: (targetSessionId, query) => runtime.events.list(targetSessionId, query),
      recordEvent: (input) => runtime.recordEvent(input),
      subscribeEvents: (listener) => runtime.subscribeEvents(listener),
      getTruthState: (targetSessionId) => runtime.getTruthState(targetSessionId),
      getTaskState: (targetSessionId) => runtime.getTaskState(targetSessionId),
    };

    const scheduler = new SchedulerService({
      runtime: runtimePort,
      enableExecution: false,
    });

    const recovered = await scheduler.recover();
    expect(recovered.rebuiltFromEvents).toBe(0);

    const created = scheduler.createIntent({
      parentSessionId: sessionId,
      reason: "runtime-port create",
      continuityMode: "inherit",
      runAt: now + 5_000,
    });
    expect(created.ok).toBe(true);

    const intents = scheduler.listIntents({ parentSessionId: sessionId });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.parentSessionId).toBe(sessionId);

    const scheduleEvents = runtime.queryEvents(sessionId, { type: SCHEDULE_EVENT_TYPE });
    expect(scheduleEvents.length).toBeGreaterThan(0);

    scheduler.stop();
  });

  test("recovers missed runAt intent and converges one-shot intent", async () => {
    const workspace = createWorkspace("recover");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-recover-session";
    const now = Date.now();

    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-recover-1",
        parentSessionId: sessionId,
        reason: "recover test",
        continuityMode: "inherit",
        runAt: now - 1_000,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduler = new SchedulerService({
      runtime,
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
      },
    });

    const recovered = await scheduler.recover();
    scheduler.stop();

    expect(recovered.rebuiltFromEvents).toBe(1);
    expect(recovered.catchUp.dueIntents).toBe(1);
    expect(recovered.catchUp.firedIntents).toBe(1);
    expect(recovered.catchUp.deferredIntents).toBe(0);
    expect(fired).toEqual(["intent-recover-1"]);

    const events = runtime.queryEvents(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_created");
    expect(kinds).toContain("intent_fired");
    expect(kinds).toContain("intent_converged");

    const projectionPath = scheduler.getProjectionPath();
    expect(existsSync(projectionPath)).toBe(true);
    const projectionContent = readFileSync(projectionPath, "utf8");
    expect(projectionContent.includes('"brewva.schedule.projection.v1"')).toBe(true);
  });

  test("recover defers overflow missed intents beyond catch-up limit", async () => {
    const workspace = createWorkspace("recover-overflow");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.maxRecoveryCatchUps = 1;
    runtime.config.schedule.minIntervalMs = 60_000;

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const sessionId = "scheduler-recover-overflow-session";
    const dueRunAt = nowMs - 10_000;

    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-overflow-1",
        parentSessionId: sessionId,
        reason: "recover overflow 1",
        continuityMode: "inherit",
        runAt: dueRunAt,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-overflow-2",
        parentSessionId: sessionId,
        reason: "recover overflow 2",
        continuityMode: "inherit",
        runAt: dueRunAt + 1,
        maxRuns: 2,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
      },
    });

    const recovered = await scheduler.recover();
    scheduler.stop();

    expect(fired).toEqual(["intent-overflow-1"]);
    expect(recovered.catchUp.dueIntents).toBe(2);
    expect(recovered.catchUp.firedIntents).toBe(1);
    expect(recovered.catchUp.deferredIntents).toBe(1);

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-overflow-2");
    expect(state?.status).toBe("active");
    expect(state?.runCount).toBe(0);
    expect(state?.nextRunAt).toBe(nowMs + runtime.config.schedule.minIntervalMs);

    const deferredEvents = runtime.queryEvents(sessionId, { type: "schedule_recovery_deferred" });
    expect(deferredEvents.length).toBe(1);
    const deferredPayload = deferredEvents[0]?.payload;
    expect(deferredPayload?.intentId).toBe("intent-overflow-2");
    expect(deferredPayload?.deferredTo).toBe(nowMs + runtime.config.schedule.minIntervalMs);
  });

  test("recover catch-up round-robins sessions and emits recovery summary events", async () => {
    const workspace = createWorkspace("recover-fairness");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.maxRecoveryCatchUps = 2;
    runtime.config.schedule.minIntervalMs = 60_000;

    const nowMs = Date.UTC(2026, 0, 1, 1, 0, 0, 0);
    const dueRunAt = nowMs - 10_000;

    runtime.recordEvent({
      sessionId: "session-fair-a",
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-fair-a1",
        parentSessionId: "session-fair-a",
        reason: "fairness a1",
        continuityMode: "inherit",
        runAt: dueRunAt,
        maxRuns: 2,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    runtime.recordEvent({
      sessionId: "session-fair-a",
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-fair-a2",
        parentSessionId: "session-fair-a",
        reason: "fairness a2",
        continuityMode: "inherit",
        runAt: dueRunAt + 1,
        maxRuns: 2,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    runtime.recordEvent({
      sessionId: "session-fair-b",
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-fair-b1",
        parentSessionId: "session-fair-b",
        reason: "fairness b1",
        continuityMode: "inherit",
        runAt: dueRunAt + 2,
        maxRuns: 2,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
      },
    });

    const recovered = await scheduler.recover();
    scheduler.stop();

    expect(fired).toEqual(["intent-fair-a1", "intent-fair-b1"]);
    expect(recovered.catchUp.dueIntents).toBe(3);
    expect(recovered.catchUp.firedIntents).toBe(2);
    expect(recovered.catchUp.deferredIntents).toBe(1);

    const catchUpSessionA = recovered.catchUp.sessions.find(
      (session) => session.parentSessionId === "session-fair-a",
    );
    const catchUpSessionB = recovered.catchUp.sessions.find(
      (session) => session.parentSessionId === "session-fair-b",
    );
    expect(catchUpSessionA).toEqual({
      parentSessionId: "session-fair-a",
      dueIntents: 2,
      firedIntents: 1,
      deferredIntents: 1,
    });
    expect(catchUpSessionB).toEqual({
      parentSessionId: "session-fair-b",
      dueIntents: 1,
      firedIntents: 1,
      deferredIntents: 0,
    });

    const summaryA = runtime.queryEvents("session-fair-a", { type: "schedule_recovery_summary" });
    const summaryB = runtime.queryEvents("session-fair-b", { type: "schedule_recovery_summary" });
    expect(summaryA.length).toBe(1);
    expect(summaryB.length).toBe(1);
    expect(summaryA[0]?.payload?.firedIntents).toBe(1);
    expect(summaryA[0]?.payload?.deferredIntents).toBe(1);
    expect(summaryB[0]?.payload?.firedIntents).toBe(1);
    expect(summaryB[0]?.payload?.deferredIntents).toBe(0);

    const deferredA = runtime.queryEvents("session-fair-a", { type: "schedule_recovery_deferred" });
    expect(deferredA.length).toBe(1);
    expect(deferredA[0]?.payload?.intentId).toBe("intent-fair-a2");
  });

  test("opens circuit after maxConsecutiveErrors", async () => {
    const workspace = createWorkspace("circuit");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.maxConsecutiveErrors = 2;
    runtime.config.schedule.minIntervalMs = 10;

    let nowMs = Date.now();
    const sessionId = "scheduler-circuit-session";

    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-circuit-1",
        parentSessionId: sessionId,
        reason: "circuit test",
        continuityMode: "inherit",
        runAt: nowMs - 1_000,
        maxRuns: 5,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      executeIntent: async () => {
        throw new Error("boom");
      },
    });

    await scheduler.recover();
    nowMs += 1_000;
    await scheduler.recover();
    scheduler.stop();

    const events = runtime.queryEvents(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const parsed = events.map((event) => parseScheduleIntentEvent(event)).filter(Boolean);
    const cancelled = parsed.find((event) => event?.kind === "intent_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.error?.startsWith("circuit_open:")).toBe(true);

    const snapshot = scheduler.snapshot();
    const state = snapshot.intents.find((intent) => intent.intentId === "intent-circuit-1");
    expect(state?.status).toBe("error");
  });

  test("enforces active intent limits", async () => {
    const workspace = createWorkspace("limits");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.maxActiveIntentsPerSession = 1;
    runtime.config.schedule.maxActiveIntentsGlobal = 2;

    const scheduler = new SchedulerService({ runtime });
    await scheduler.recover();

    const now = Date.now() + 120_000;
    const createdA = scheduler.createIntent({
      parentSessionId: "session-a",
      reason: "limit-A",
      continuityMode: "inherit",
      runAt: now,
    });
    expect(createdA.ok).toBe(true);

    const rejectedSession = scheduler.createIntent({
      parentSessionId: "session-a",
      reason: "limit-A2",
      continuityMode: "inherit",
      runAt: now + 10_000,
    });
    expect(rejectedSession.ok).toBe(false);
    if (!rejectedSession.ok) {
      expect(rejectedSession.error).toBe("max_active_intents_per_session_exceeded");
    }

    const createdB = scheduler.createIntent({
      parentSessionId: "session-b",
      reason: "limit-B",
      continuityMode: "inherit",
      runAt: now + 20_000,
    });
    expect(createdB.ok).toBe(true);

    const rejectedGlobal = scheduler.createIntent({
      parentSessionId: "session-c",
      reason: "limit-C",
      continuityMode: "inherit",
      runAt: now + 30_000,
    });
    expect(rejectedGlobal.ok).toBe(false);
    if (!rejectedGlobal.ok) {
      expect(rejectedGlobal.error).toBe("max_active_intents_global_exceeded");
    }

    scheduler.stop();
  });

  test("keeps execution disabled when no executor callback is provided", async () => {
    const workspace = createWorkspace("no-executor");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const now = Date.now();
    const sessionId = "scheduler-no-executor-session";

    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-no-executor-1",
        parentSessionId: sessionId,
        reason: "no executor",
        continuityMode: "inherit",
        runAt: now - 1_000,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({ runtime });
    await scheduler.recover();
    const stats = scheduler.getStats();
    scheduler.stop();

    expect(stats.executionEnabled).toBe(false);
    const events = runtime.queryEvents(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toEqual(["intent_created"]);
  });

  test("rejects duplicate intentId on create", async () => {
    const workspace = createWorkspace("duplicate-id");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({ runtime, enableExecution: false });
    await scheduler.recover();

    const runAt = Date.now() + 120_000;
    const first = scheduler.createIntent({
      parentSessionId: "session-dup",
      reason: "first",
      continuityMode: "inherit",
      runAt,
      intentId: "intent-fixed-id",
    });
    expect(first.ok).toBe(true);

    const second = scheduler.createIntent({
      parentSessionId: "session-dup",
      reason: "second",
      continuityMode: "inherit",
      runAt: runAt + 1_000,
      intentId: "intent-fixed-id",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe("intent_id_already_exists");
    }

    scheduler.stop();
  });

  test("replay keeps append order for same-timestamp events", async () => {
    const workspace = createWorkspace("same-timestamp-order");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "session-same-timestamp-order";
    const intentId = "intent-same-timestamp-order";
    const timestamp = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const runAt = timestamp + 120_000;

    const createRow = {
      id: "evt_1735689600000_zzzzzzzz",
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      timestamp,
      payload: buildScheduleIntentCreatedEvent({
        intentId,
        parentSessionId: sessionId,
        reason: "created-first",
        continuityMode: "inherit",
        runAt,
        maxRuns: 1,
      }),
    };
    const cancelRow = {
      id: "evt_1735689600000_aaaaaaaa",
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      timestamp,
      payload: buildScheduleIntentCancelledEvent({
        intentId,
        parentSessionId: sessionId,
        reason: "cancelled-second",
        continuityMode: "inherit",
        runAt,
        maxRuns: 1,
      }),
    };
    const eventsFilePath = join(
      workspace,
      runtime.config.infrastructure.events.dir,
      `${sessionId}.jsonl`,
    );
    writeFileSync(eventsFilePath, `${JSON.stringify(createRow)}\n${JSON.stringify(cancelRow)}\n`);

    const scheduler = new SchedulerService({ runtime, enableExecution: false });
    await scheduler.recover();
    const state = scheduler.snapshot().intents.find((intent) => intent.intentId === intentId);
    scheduler.stop();

    expect(state?.status).toBe("cancelled");
    expect(state?.reason).toBe("cancelled-second");
    expect(state?.nextRunAt).toBeUndefined();
  });

  test("updates active intent schedule target and emits intent_updated", async () => {
    const workspace = createWorkspace("update-intent");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;
    const scheduler = new SchedulerService({ runtime, enableExecution: false });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-update",
      reason: "initial",
      continuityMode: "inherit",
      runAt: Date.now() + 300_000,
      maxRuns: 5,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update",
      intentId: created.intent.intentId,
      reason: "updated",
      cron: "*/20 * * * *",
      timeZone: "Asia/Shanghai",
      maxRuns: 8,
    });
    scheduler.stop();

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.intent.reason).toBe("updated");
    expect(updated.intent.cron).toBe("*/20 * * * *");
    expect(updated.intent.timeZone).toBe("Asia/Shanghai");
    expect(updated.intent.maxRuns).toBe(8);
    expect(updated.intent.runAt).toBeUndefined();
    expect(typeof updated.intent.nextRunAt).toBe("number");

    const events = runtime.queryEvents("session-update", { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_updated");
  });

  test("updates cron intent timeZone without changing cron expression", async () => {
    const workspace = createWorkspace("update-timezone-only");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-update-timezone-only",
      reason: "timezone only",
      continuityMode: "inherit",
      cron: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      maxRuns: 3,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update-timezone-only",
      intentId: created.intent.intentId,
      timeZone: "America/New_York",
    });
    scheduler.stop();

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.intent.cron).toBe("0 9 * * *");
    expect(updated.intent.timeZone).toBe("America/New_York");
    expect(updated.intent.nextRunAt).toBe(Date.UTC(2026, 0, 1, 14, 0, 0, 0));
  });

  test("rejects update when intent is not active", async () => {
    const workspace = createWorkspace("update-not-active");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({ runtime, enableExecution: false });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-update-not-active",
      reason: "initial",
      continuityMode: "inherit",
      runAt: Date.now() + 180_000,
      maxRuns: 3,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const cancelled = scheduler.cancelIntent({
      parentSessionId: "session-update-not-active",
      intentId: created.intent.intentId,
    });
    expect(cancelled.ok).toBe(true);

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update-not-active",
      intentId: created.intent.intentId,
      reason: "should fail",
    });
    scheduler.stop();

    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.error).toBe("intent_not_active");
    }
  });

  test("rejects timeZone-only update for runAt intent", async () => {
    const workspace = createWorkspace("update-timezone-runat-guard");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({ runtime, enableExecution: false });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-update-timezone-runat-guard",
      reason: "runAt intent",
      continuityMode: "inherit",
      runAt: Date.now() + 180_000,
      maxRuns: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const updated = scheduler.updateIntent({
      parentSessionId: "session-update-timezone-runat-guard",
      intentId: created.intent.intentId,
      timeZone: "Asia/Shanghai",
    });
    scheduler.stop();

    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.error).toBe("timeZone_requires_cron");
    }
  });

  test("converges by structured predicate (truth_resolved)", async () => {
    const workspace = createWorkspace("predicate-truth");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "scheduler-predicate-session";
    const now = Date.now();

    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-predicate-1",
        parentSessionId: sessionId,
        reason: "wait for ci_green",
        continuityMode: "inherit",
        runAt: now - 1_000,
        maxRuns: 5,
        convergenceCondition: {
          kind: "truth_resolved",
          factId: "ci_green",
        },
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const scheduler = new SchedulerService({
      runtime,
      executeIntent: async (intent) => {
        const evaluationSessionId = `${intent.parentSessionId}-child`;
        runtime.upsertTruthFact(evaluationSessionId, {
          id: "ci_green",
          kind: "ci_pipeline",
          severity: "info",
          summary: "CI pipeline passed",
          status: "resolved",
        });
        return { evaluationSessionId };
      },
    });

    await scheduler.recover();
    scheduler.stop();

    const events = runtime.queryEvents(sessionId, { type: SCHEDULE_EVENT_TYPE });
    const kinds = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toContain("intent_fired");
    expect(kinds).toContain("intent_converged");
    const fired = events
      .map(parseScheduleIntentEvent)
      .find((event) => event?.kind === "intent_fired");
    expect(fired?.childSessionId).toBe(`${sessionId}-child`);

    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-predicate-1");
    expect(state?.status).toBe("converged");
    expect(state?.runCount).toBe(1);
    expect(state?.lastEvaluationSessionId).toBe(`${sessionId}-child`);
  });

  test("creates cron intent with computed nextRunAt", async () => {
    const workspace = createWorkspace("cron-create");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;

    let nowMs = Date.UTC(2026, 0, 1, 0, 1, 30, 0);
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-create",
      reason: "cron create",
      continuityMode: "inherit",
      cron: "*/5 * * * *",
      maxRuns: 5,
    });
    scheduler.stop();

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.intent.cron).toBe("*/5 * * * *");
    expect(typeof created.intent.timeZone).toBe("string");
    expect(typeof created.intent.nextRunAt).toBe("number");
    if (typeof created.intent.nextRunAt === "number") {
      expect(created.intent.nextRunAt).toBeGreaterThan(
        nowMs + runtime.config.schedule.minIntervalMs - 1,
      );
      expect(new Date(created.intent.nextRunAt).getMinutes() % 5).toBe(0);
    }
  });

  test("creates cron intent with explicit timeZone", async () => {
    const workspace = createWorkspace("cron-timezone");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-timezone",
      reason: "cron with timezone",
      continuityMode: "inherit",
      cron: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      maxRuns: 2,
    });
    scheduler.stop();

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.intent.timeZone).toBe("Asia/Shanghai");
    expect(created.intent.nextRunAt).toBe(Date.UTC(2026, 0, 1, 1, 0, 0, 0));
  });

  test("rejects invalid cron expression on create", async () => {
    const workspace = createWorkspace("cron-invalid");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-invalid",
      reason: "invalid cron",
      continuityMode: "inherit",
      cron: "* *",
    });
    scheduler.stop();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe("invalid_cron");
    }
  });

  test("rejects invalid timeZone on create", async () => {
    const workspace = createWorkspace("cron-invalid-timezone");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-invalid-timezone",
      reason: "invalid timezone",
      continuityMode: "inherit",
      cron: "*/5 * * * *",
      timeZone: "Not/A_Real_Timezone",
    });
    scheduler.stop();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe("invalid_time_zone");
    }
  });

  test("rejects timeZone when cron is not provided", async () => {
    const workspace = createWorkspace("timezone-requires-cron");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-timezone-guard",
      reason: "timezone guard",
      continuityMode: "inherit",
      runAt: Date.now() + 120_000,
      timeZone: "Asia/Shanghai",
    });
    scheduler.stop();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe("timeZone_requires_cron");
    }
  });

  test("defaults maxRuns to 10000 for cron intents", async () => {
    const workspace = createWorkspace("cron-default-max-runs");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const scheduler = new SchedulerService({
      runtime,
      enableExecution: false,
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-default-max-runs",
      reason: "default max runs",
      continuityMode: "inherit",
      cron: "*/15 * * * *",
    });
    scheduler.stop();

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.intent.maxRuns).toBe(10_000);
  });

  test("recover catches up missed cron run and schedules next slot", async () => {
    const workspace = createWorkspace("cron-recover");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;

    let nowMs = Date.UTC(2026, 0, 1, 0, 1, 30, 0);
    const executed: number[] = [];
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      executeIntent: async () => {
        executed.push(nowMs);
      },
    });
    await scheduler.recover();

    const created = scheduler.createIntent({
      parentSessionId: "session-cron-recover",
      reason: "cron recover",
      continuityMode: "inherit",
      cron: "*/2 * * * *",
      maxRuns: 3,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      scheduler.stop();
      return;
    }

    const firstNextRunAt = created.intent.nextRunAt;
    expect(typeof firstNextRunAt).toBe("number");
    if (typeof firstNextRunAt === "number") {
      nowMs = firstNextRunAt + 30_000;
    }

    await scheduler.recover();
    scheduler.stop();

    expect(executed.length).toBe(1);
    const state = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === created.intent.intentId);
    expect(state?.status).toBe("active");
    expect(state?.runCount).toBe(1);
    expect(typeof state?.nextRunAt).toBe("number");
    if (typeof state?.nextRunAt === "number" && typeof firstNextRunAt === "number") {
      expect(state.nextRunAt).toBeGreaterThan(firstNextRunAt);
      expect(new Date(state.nextRunAt).getMinutes() % 2).toBe(0);
    }

    const events = runtime.queryEvents("session-cron-recover", { type: SCHEDULE_EVENT_TYPE });
    const firedCount = events
      .map((event) => parseScheduleIntentEvent(event)?.kind)
      .filter((kind) => kind === "intent_fired").length;
    expect(firedCount).toBe(1);
  });

  test("revives converged intent when maxRuns is increased via update", async () => {
    const workspace = createWorkspace("revive-converged");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const sessionId = "session-revive";
    const dueRunAt = nowMs - 1_000;

    runtime.recordEvent({
      sessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: buildScheduleIntentCreatedEvent({
        intentId: "intent-revive-1",
        parentSessionId: sessionId,
        reason: "revive test",
        continuityMode: "inherit",
        runAt: dueRunAt,
        maxRuns: 1,
      }) as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });

    const fired: string[] = [];
    const scheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      executeIntent: async (intent) => {
        fired.push(intent.intentId);
      },
    });
    await scheduler.recover();
    expect(fired.length).toBe(1);

    const converged = scheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === "intent-revive-1");
    expect(converged?.status).toBe("converged");
    expect(converged?.nextRunAt).toBeUndefined();

    const updated = scheduler.updateIntent({
      parentSessionId: sessionId,
      intentId: "intent-revive-1",
      maxRuns: 5,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      scheduler.stop();
      return;
    }
    expect(updated.intent.status).toBe("active");
    expect(typeof updated.intent.nextRunAt).toBe("number");
    expect(updated.intent.maxRuns).toBe(5);

    scheduler.stop();
  });

  test("daemon subscribes to runtime events from external intent creation", async () => {
    const workspace = createWorkspace("subscribe-events");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.schedule.minIntervalMs = 60_000;

    const nowMs = Date.UTC(2026, 0, 1, 0, 30, 0, 0);
    const daemonScheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      executeIntent: async () => {},
    });
    await daemonScheduler.recover();

    const externalScheduler = new SchedulerService({
      runtime,
      now: () => nowMs,
      enableExecution: false,
    });
    await externalScheduler.recover();

    const created = externalScheduler.createIntent({
      parentSessionId: "session-external",
      reason: "created externally",
      continuityMode: "inherit",
      runAt: nowMs + 120_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      daemonScheduler.stop();
      externalScheduler.stop();
      return;
    }

    const daemonIntent = daemonScheduler
      .snapshot()
      .intents.find((intent) => intent.intentId === created.intent.intentId);
    expect(daemonIntent).toBeDefined();
    expect(daemonIntent?.status).toBe("active");
    expect(daemonIntent?.reason).toBe("created externally");

    daemonScheduler.stop();
    externalScheduler.stop();
  });
});
