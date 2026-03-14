import { join } from "node:path";
import {
  SessionSupervisor,
  executeScheduleIntentRun,
  removePidRecord,
  writePidRecord,
} from "@brewva/brewva-gateway";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SchedulerService,
  createTrustedLocalGovernancePort,
  parseScheduleIntentEvent,
} from "@brewva/brewva-runtime";
import { TurnWALStore } from "@brewva/brewva-runtime/channels";
import { differenceInSeconds, formatISO } from "date-fns";

export interface RunDaemonOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  enableExtensions: boolean;
  verbose: boolean;
  onRuntimeReady?: (runtime: BrewvaRuntime) => void;
}

interface DaemonLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void;
}

function createDaemonLogger(verbose: boolean): DaemonLogger {
  const write =
    (emit: boolean, level: "debug" | "info" | "warn" | "error" | "log") =>
    (message: string, fields?: Record<string, unknown>): void => {
      if (!emit) {
        return;
      }
      const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
      console.error(`[scheduler:${level}] ${message}${suffix}`);
    };

  return {
    debug: write(verbose, "debug"),
    info: write(verbose, "info"),
    warn: write(true, "warn"),
    error: write(true, "error"),
    log: (level, message, fields) => write(verbose, level)(message, fields),
  };
}

export async function runDaemon(parsed: RunDaemonOptions): Promise<void> {
  const runtime = new BrewvaRuntime({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    agentId: parsed.agentId,
    governancePort: createTrustedLocalGovernancePort(),
  });
  parsed.onRuntimeReady?.(runtime);

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

  const turnWalStore = new TurnWALStore({
    workspaceRoot: runtime.workspaceRoot,
    config: runtime.config.infrastructure.turnWal,
    scope: "scheduler",
  });
  const supervisor = new SessionSupervisor({
    stateDir: join(runtime.workspaceRoot, ".brewva", "scheduler-state"),
    logger: createDaemonLogger(parsed.verbose),
    defaultCwd: runtime.cwd,
    defaultConfigPath: parsed.configPath,
    defaultModel: parsed.model,
    defaultEnableExtensions: parsed.enableExtensions,
    turnWalStore,
    turnWalCompactIntervalMs: Math.max(
      30_000,
      Math.floor(runtime.config.infrastructure.turnWal.compactAfterMs / 2),
    ),
  });
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
    if (event.type === SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE) {
      summaryWindow.deferredIntents += 1;
      return;
    }
    if (event.type === SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE) {
      summaryWindow.childStarted += 1;
      return;
    }
    if (event.type === SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE) {
      summaryWindow.childFinished += 1;
      return;
    }
    if (event.type === SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE) {
      summaryWindow.childFailed += 1;
      return;
    }
    if (event.type !== SCHEDULE_EVENT_TYPE) return;

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
  let scheduler: SchedulerService | null = null;
  let supervisorStarted = false;
  try {
    await supervisor.start();
    supervisorStarted = true;
    scheduler = new SchedulerService({
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
        return await executeScheduleIntentRun({
          runtime,
          backend: supervisor,
          intent,
          cwd: parsed.cwd,
          configPath: parsed.configPath,
          model: parsed.model,
          enableExtensions: parsed.enableExtensions,
        });
      },
    });
    const recovered = await scheduler.recover();
    const stats = scheduler.getStats();
    if (!stats.executionEnabled) {
      console.error(
        "brewva scheduler daemon: execution is disabled because no intent executor is configured.",
      );
      scheduler.stop();
      if (summaryInterval) {
        clearInterval(summaryInterval);
      }
      unsubscribeEvents();
      await supervisor.stop();
      removePidRecord(pidFilePath);
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
        scheduler?.stop();
        if (summaryInterval) {
          clearInterval(summaryInterval);
        }
        void supervisor.stop().finally(() => {
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
  } catch (error) {
    scheduler?.stop();
    if (summaryInterval) {
      clearInterval(summaryInterval);
    }
    unsubscribeEvents();
    if (supervisorStarted) {
      await supervisor.stop().catch(() => undefined);
    }
    removePidRecord(pidFilePath);
    throw error;
  }
}
