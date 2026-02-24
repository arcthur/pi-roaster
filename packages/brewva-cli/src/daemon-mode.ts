import { join } from "node:path";
import { writePidRecord, removePidRecord } from "@brewva/brewva-gateway";
import {
  BrewvaRuntime,
  SchedulerService,
  parseScheduleIntentEvent,
  type ScheduleIntentProjectionRecord,
} from "@brewva/brewva-runtime";
import { differenceInSeconds, formatISO } from "date-fns";
import { clampText, ensureSessionShutdownRecorded } from "./runtime-utils.js";
import { createBrewvaSession, type BrewvaSessionResult } from "./session.js";

export interface RunDaemonOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  enableExtensions: boolean;
  verbose: boolean;
  onRuntimeReady?: (runtime: BrewvaRuntime) => void;
}

function inheritScheduleContext(
  runtime: BrewvaRuntime,
  input: { parentSessionId: string; childSessionId: string; continuityMode: "inherit" | "fresh" },
): {
  taskSpecCopied: boolean;
  truthFactsCopied: number;
  parentAnchor?: { id: string; name?: string; summary?: string; nextSteps?: string };
} {
  const parentAnchor = runtime.events.getTapeStatus(input.parentSessionId).lastAnchor;
  if (input.continuityMode !== "inherit") {
    return {
      taskSpecCopied: false,
      truthFactsCopied: 0,
      parentAnchor,
    };
  }

  const parentTask = runtime.task.getState(input.parentSessionId);
  if (parentTask.spec) {
    runtime.task.setSpec(input.childSessionId, parentTask.spec);
  }

  const parentTruth = runtime.truth.getState(input.parentSessionId);
  let copied = 0;
  for (const fact of parentTruth.facts) {
    const result = runtime.truth.upsertFact(input.childSessionId, {
      id: fact.id,
      kind: fact.kind,
      severity: fact.severity,
      summary: fact.summary,
      details: fact.details as Record<string, unknown> | undefined,
      evidenceIds: fact.evidenceIds,
      status: fact.status,
    });
    if (result.ok) {
      copied += 1;
    }
  }

  if (parentAnchor) {
    runtime.events.recordTapeHandoff(input.childSessionId, {
      name: `schedule:inherit:${parentAnchor.name ?? "parent"}`,
      summary: parentAnchor.summary,
      nextSteps: parentAnchor.nextSteps,
    });
  }

  return {
    taskSpecCopied: Boolean(parentTask.spec),
    truthFactsCopied: copied,
    parentAnchor,
  };
}

function buildScheduleWakeupMessage(input: {
  intent: ScheduleIntentProjectionRecord;
  runIndex: number;
  inherited: {
    taskSpecCopied: boolean;
    truthFactsCopied: number;
    parentAnchor?: { id: string; name?: string; summary?: string; nextSteps?: string };
  };
}): string {
  const anchor = input.inherited.parentAnchor;
  const lines = [
    "[Schedule Wakeup]",
    `intent_id: ${input.intent.intentId}`,
    `parent_session_id: ${input.intent.parentSessionId}`,
    `run_index: ${input.runIndex}`,
    `reason: ${input.intent.reason}`,
    `continuity_mode: ${input.intent.continuityMode}`,
    `time_zone: ${input.intent.timeZone ?? "none"}`,
    `goal_ref: ${input.intent.goalRef ?? "none"}`,
    `inherited_task_spec: ${input.inherited.taskSpecCopied ? "yes" : "no"}`,
    `inherited_truth_facts: ${input.inherited.truthFactsCopied}`,
    `parent_anchor_id: ${anchor?.id ?? "none"}`,
    `parent_anchor_name: ${anchor?.name ?? "none"}`,
  ];

  const anchorSummary = clampText(anchor?.summary, 320);
  if (anchorSummary) lines.push(`parent_anchor_summary: ${anchorSummary}`);
  const nextSteps = clampText(anchor?.nextSteps, 320);
  if (nextSteps) lines.push(`parent_anchor_next_steps: ${nextSteps}`);

  lines.push("Please continue the task from this wakeup context and produce concrete progress.");
  return lines.join("\n");
}

export async function runDaemon(parsed: RunDaemonOptions): Promise<void> {
  const runtime = new BrewvaRuntime({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    agentId: parsed.agentId,
  });
  parsed.onRuntimeReady?.(runtime);

  const pidFilePath = join(runtime.workspaceRoot, ".brewva", "scheduler.pid");
  try {
    writePidRecord(pidFilePath, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 0,
      startedAt: Date.now(),
      cwd: runtime.workspaceRoot,
    });
  } catch (error) {
    console.error(
      `brewva scheduler daemon: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!runtime.config.schedule.enabled) {
    console.error("brewva scheduler daemon: disabled by config (schedule.enabled=false).");
    process.exitCode = 1;
    return;
  }
  if (!runtime.config.infrastructure.events.enabled) {
    console.error(
      "brewva scheduler daemon: requires infrastructure.events.enabled=true for durable event replay.",
    );
    process.exitCode = 1;
    return;
  }

  const activeRuns = new Map<string, BrewvaSessionResult["session"]>();
  const summaryWindow = {
    startedAtMs: Date.now(),
    firedIntents: 0,
    erroredIntents: 0,
    deferredIntents: 0,
    circuitOpened: 0,
    childStarted: 0,
    childFinished: 0,
    childFailed: 0,
  };
  const emitSummaryWindow = (reason: "tick" | "shutdown"): void => {
    if (!parsed.verbose) return;
    const nowMs = Date.now();
    const windowSeconds = Math.max(1, differenceInSeconds(nowMs, summaryWindow.startedAtMs));
    console.error(
      `[daemon][${reason}] window_start=${formatISO(new Date(summaryWindow.startedAtMs))} window_s=${windowSeconds} fired=${summaryWindow.firedIntents} errored=${summaryWindow.erroredIntents} deferred=${summaryWindow.deferredIntents} circuit_opened=${summaryWindow.circuitOpened} child_started=${summaryWindow.childStarted} child_finished=${summaryWindow.childFinished} child_failed=${summaryWindow.childFailed}`,
    );
    summaryWindow.startedAtMs = nowMs;
    summaryWindow.firedIntents = 0;
    summaryWindow.erroredIntents = 0;
    summaryWindow.deferredIntents = 0;
    summaryWindow.circuitOpened = 0;
    summaryWindow.childStarted = 0;
    summaryWindow.childFinished = 0;
    summaryWindow.childFailed = 0;
  };
  const unsubscribeEvents = runtime.events.subscribe((event) => {
    if (event.type === "schedule_recovery_deferred") {
      summaryWindow.deferredIntents += 1;
      return;
    }
    if (event.type === "schedule_child_session_started") {
      summaryWindow.childStarted += 1;
      return;
    }
    if (event.type === "schedule_child_session_finished") {
      summaryWindow.childFinished += 1;
      return;
    }
    if (event.type === "schedule_child_session_failed") {
      summaryWindow.childFailed += 1;
      return;
    }
    if (event.type !== "schedule_intent") return;

    const payload = parseScheduleIntentEvent({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      payload: event.payload,
    });
    if (!payload) return;
    if (payload.kind === "intent_fired") {
      if (payload.error) {
        summaryWindow.erroredIntents += 1;
      } else {
        summaryWindow.firedIntents += 1;
      }
      return;
    }
    if (payload.kind === "intent_cancelled" && payload.error?.startsWith("circuit_open:")) {
      summaryWindow.circuitOpened += 1;
    }
  });
  const summaryInterval = parsed.verbose
    ? setInterval(() => emitSummaryWindow("tick"), 60_000)
    : null;
  summaryInterval?.unref?.();
  const turnWalCompactIntervalMs = Math.max(
    30_000,
    Math.floor(runtime.config.infrastructure.turnWal.compactAfterMs / 2),
  );
  const turnWalCompactTimer = runtime.config.infrastructure.turnWal.enabled
    ? setInterval(() => {
        try {
          runtime.turnWal.compact();
        } catch (error) {
          if (parsed.verbose) {
            const text = error instanceof Error ? error.message : String(error);
            console.error(`[daemon] turn wal compact failed: ${text}`);
          }
        }
      }, turnWalCompactIntervalMs)
    : null;
  turnWalCompactTimer?.unref?.();
  const scheduler = new SchedulerService({
    runtime: {
      workspaceRoot: runtime.workspaceRoot,
      scheduleConfig: runtime.config.schedule,
      listSessionIds: () => runtime.events.listSessionIds(),
      listEvents: (sessionId, query) => runtime.events.list(sessionId, query),
      recordEvent: (input) => runtime.events.record(input),
      subscribeEvents: (listener) => runtime.events.subscribe(listener),
      getTruthState: (sessionId) => runtime.truth.getState(sessionId),
      getTaskState: (sessionId) => runtime.task.getState(sessionId),
      turnWal: {
        appendPending: (envelope, source, options) =>
          runtime.turnWal.appendPending(envelope, source, options),
        markInflight: (walId) => runtime.turnWal.markInflight(walId),
        markDone: (walId) => runtime.turnWal.markDone(walId),
        markFailed: (walId, error) => runtime.turnWal.markFailed(walId, error),
        markExpired: (walId) => runtime.turnWal.markExpired(walId),
        listPending: () => runtime.turnWal.listPending(),
      },
    },
    executeIntent: async (intent) => {
      const runIndex = intent.runCount + 1;
      const child = await createBrewvaSession({
        cwd: parsed.cwd,
        configPath: parsed.configPath,
        model: parsed.model,
        enableExtensions: parsed.enableExtensions,
        runtime,
      });
      const childSessionId = child.session.sessionManager.getSessionId();
      activeRuns.set(childSessionId, child.session);

      const inherited = inheritScheduleContext(runtime, {
        parentSessionId: intent.parentSessionId,
        childSessionId,
        continuityMode: intent.continuityMode,
      });
      const wakeupMessage = buildScheduleWakeupMessage({
        intent,
        runIndex,
        inherited,
      });

      runtime.events.record({
        sessionId: childSessionId,
        type: "schedule_wakeup",
        payload: {
          schema: "brewva.schedule-wakeup.v1",
          intentId: intent.intentId,
          parentSessionId: intent.parentSessionId,
          runIndex,
          reason: intent.reason,
          continuityMode: intent.continuityMode,
          timeZone: intent.timeZone ?? null,
          goalRef: intent.goalRef ?? null,
          inheritedTaskSpec: inherited.taskSpecCopied,
          inheritedTruthFacts: inherited.truthFactsCopied,
          parentAnchorId: inherited.parentAnchor?.id ?? null,
        },
      });
      runtime.events.record({
        sessionId: intent.parentSessionId,
        type: "schedule_child_session_started",
        payload: {
          intentId: intent.intentId,
          childSessionId,
          runIndex,
        },
      });

      try {
        await child.session.sendUserMessage(wakeupMessage);
        await child.session.agent.waitForIdle();
        runtime.events.record({
          sessionId: intent.parentSessionId,
          type: "schedule_child_session_finished",
          payload: {
            intentId: intent.intentId,
            childSessionId,
            runIndex,
          },
        });
        return { evaluationSessionId: childSessionId };
      } catch (error) {
        runtime.events.record({
          sessionId: intent.parentSessionId,
          type: "schedule_child_session_failed",
          payload: {
            intentId: intent.intentId,
            childSessionId,
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      } finally {
        ensureSessionShutdownRecorded(runtime, childSessionId);
        activeRuns.delete(childSessionId);
        child.session.dispose();
      }
    },
  });
  const recovered = await scheduler.recover();
  const stats = scheduler.getStats();
  if (!stats.executionEnabled) {
    console.error(
      "brewva scheduler daemon: execution is disabled because no intent executor is configured.",
    );
    scheduler.stop();
    process.exitCode = 1;
    return;
  }
  if (parsed.verbose) {
    console.error(
      `[daemon] projection=${stats.projectionPath} active=${stats.intentsActive}/${stats.intentsTotal} timers=${stats.timersArmed} events=${recovered.rebuiltFromEvents} matched=${recovered.projectionMatched} catchup_due=${recovered.catchUp.dueIntents} catchup_fired=${recovered.catchUp.firedIntents} catchup_deferred=${recovered.catchUp.deferredIntents} catchup_sessions=${recovered.catchUp.sessions.length}`,
    );
  }

  await new Promise<void>((complete) => {
    let resolved = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (resolved) return;
      resolved = true;
      scheduler.stop();
      if (summaryInterval) {
        clearInterval(summaryInterval);
      }
      if (turnWalCompactTimer) {
        clearInterval(turnWalCompactTimer);
      }

      const abortAll = async (): Promise<void> => {
        await Promise.allSettled(
          [...activeRuns.values()].map(async (session) => {
            try {
              await session.abort();
            } catch {
              // Best effort abort during daemon shutdown.
            }
          }),
        );
      };

      void abortAll().finally(() => {
        emitSummaryWindow("shutdown");
        unsubscribeEvents();
        removePidRecord(pidFilePath);
        if (parsed.verbose) {
          console.error(`[daemon] received ${signal}, scheduler stopped.`);
        }
        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        complete();
      });
    };

    const onSigInt = (): void => shutdown("SIGINT");
    const onSigTerm = (): void => shutdown("SIGTERM");
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
  });
}
