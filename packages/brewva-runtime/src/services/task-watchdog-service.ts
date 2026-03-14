import {
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import {
  SCAN_CONVERGENCE_BLOCKER_ID,
  WATCHDOG_BLOCKER_ID,
  WATCHDOG_BLOCKER_SOURCE,
  buildTaskStuckBlockerMessage,
  buildTaskStuckClearedPayload,
  buildTaskStuckDetectedPayload,
  coerceTaskStuckDetectedPayload,
  computeTaskSemanticProgressAt,
  evaluateTaskWatchdogEligibility,
  getTaskWatchdogBlocker,
  getTaskWatchdogOpenItemCount,
  resolveTaskWatchdogPhase,
  toTaskWatchdogEventPayload,
  type TaskWatchdogPhase,
} from "../task/watchdog.js";
import type { BrewvaEventQuery, BrewvaEventRecord, TaskState } from "../types.js";
import type { TaskService } from "./task.js";

const DEFAULT_THRESHOLDS_MS: Record<TaskWatchdogPhase, number> = {
  investigate: 5 * 60_000,
  execute: 10 * 60_000,
  verify: 5 * 60_000,
};

function sanitizeDelayMs(value: number | undefined, fallbackMs: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallbackMs;
  return Math.max(1_000, candidate);
}

function createThresholdPolicy(
  overrides?: Partial<Record<TaskWatchdogPhase, number>>,
): Readonly<Record<TaskWatchdogPhase, number>> {
  return {
    investigate: sanitizeDelayMs(overrides?.investigate, DEFAULT_THRESHOLDS_MS.investigate),
    execute: sanitizeDelayMs(overrides?.execute, DEFAULT_THRESHOLDS_MS.execute),
    verify: sanitizeDelayMs(overrides?.verify, DEFAULT_THRESHOLDS_MS.verify),
  };
}

function buildDetectionKey(input: {
  phase: TaskWatchdogPhase;
  baselineProgressAt: number;
  suppressedBy: string | null;
}): string {
  return `${input.phase}:${input.baselineProgressAt}:${input.suppressedBy ?? ""}`;
}

export interface PollTaskProgressInput {
  sessionId: string;
  now?: number;
  thresholdsMs?: Partial<Record<TaskWatchdogPhase, number>>;
}

export interface TaskWatchdogServiceOptions {
  listEvents: (sessionId: string, query?: BrewvaEventQuery) => BrewvaEventRecord[];
  getTaskState: RuntimeKernelContext["getTaskState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
}

export class TaskWatchdogService {
  private readonly listEvents: TaskWatchdogServiceOptions["listEvents"];
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordTaskBlocker: (
    sessionId: string,
    input: { id?: string; message: string; source?: string; truthFactId?: string },
  ) => { ok: boolean; blockerId?: string; error?: string };
  private readonly resolveTaskBlocker: (
    sessionId: string,
    blockerId: string,
  ) => { ok: boolean; error?: string };
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly taskDetectionKeyBySession = new Map<string, string>();

  constructor(options: TaskWatchdogServiceOptions) {
    this.listEvents = (sessionId, query) => options.listEvents(sessionId, query);
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordTaskBlocker = (sessionId, input) =>
      options.taskService.recordTaskBlocker(sessionId, input);
    this.resolveTaskBlocker = (sessionId, blockerId) =>
      options.taskService.resolveTaskBlocker(sessionId, blockerId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  onTurnStart(sessionId: string): void {
    this.maybeClearTaskProgressStall(sessionId);
  }

  pollTaskProgress(input: PollTaskProgressInput): void {
    const taskState = this.getTaskState(input.sessionId);
    const eligibility = evaluateTaskWatchdogEligibility(taskState);
    if (!eligibility.eligible || !eligibility.phase) {
      return;
    }

    const taskEvents = this.listEvents(input.sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.listEvents(input.sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? null;
    const baselineProgressAt = computeTaskSemanticProgressAt({
      state: taskState,
      taskEvents,
      lastVerificationAt,
    });
    if (baselineProgressAt === null) {
      return;
    }

    const thresholdPolicy = createThresholdPolicy(input.thresholdsMs);
    const thresholdMs = thresholdPolicy[eligibility.phase];
    const detectedAt = input.now ?? Date.now();
    const idleMs = Math.max(0, detectedAt - baselineProgressAt);
    if (idleMs < thresholdMs) {
      return;
    }

    const suppressedBy = eligibility.suppressedByBlockerId ?? null;
    if (suppressedBy === SCAN_CONVERGENCE_BLOCKER_ID && eligibility.hasWatchdogBlocker) {
      this.resolveTaskBlocker(input.sessionId, WATCHDOG_BLOCKER_ID);
    }
    const detectionKey = buildDetectionKey({
      phase: eligibility.phase,
      baselineProgressAt,
      suppressedBy,
    });
    if (this.taskDetectionKeyBySession.get(input.sessionId) === detectionKey) {
      return;
    }

    const latestDetected = this.listEvents(input.sessionId, {
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      last: 1,
    })[0];
    const latestPayload = coerceTaskStuckDetectedPayload(latestDetected?.payload);
    if (
      latestPayload &&
      buildDetectionKey({
        phase: latestPayload.phase,
        baselineProgressAt: latestPayload.baselineProgressAt,
        suppressedBy: latestPayload.suppressedBy,
      }) === detectionKey
    ) {
      this.taskDetectionKeyBySession.set(input.sessionId, detectionKey);
      return;
    }

    let blockerWritten = false;
    if (!suppressedBy && !eligibility.hasWatchdogBlocker) {
      const result = this.recordTaskBlocker(input.sessionId, {
        id: WATCHDOG_BLOCKER_ID,
        message: buildTaskStuckBlockerMessage({
          phase: eligibility.phase,
          idleMs,
          thresholdMs,
          baselineProgressAt,
          openItemCount: getTaskWatchdogOpenItemCount(taskState),
        }),
        source: WATCHDOG_BLOCKER_SOURCE,
      });
      blockerWritten = result.ok;
    }

    const detectedPayload = buildTaskStuckDetectedPayload({
      phase: eligibility.phase,
      thresholdMs,
      baselineProgressAt,
      detectedAt,
      idleMs,
      openItemCount: getTaskWatchdogOpenItemCount(taskState),
      blockerId: blockerWritten ? WATCHDOG_BLOCKER_ID : null,
      blockerWritten,
      suppressedBy,
    });

    this.recordEvent({
      sessionId: input.sessionId,
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: toTaskWatchdogEventPayload(detectedPayload),
    });
    this.taskDetectionKeyBySession.set(input.sessionId, detectionKey);
  }

  clear(sessionId: string): void {
    this.taskDetectionKeyBySession.delete(sessionId);
  }

  private maybeClearTaskProgressStall(sessionId: string): void {
    const taskState = this.getTaskState(sessionId);
    const watchdogBlocker = getTaskWatchdogBlocker(taskState);
    if (!watchdogBlocker) {
      return;
    }

    const taskEvents = this.listEvents(sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.listEvents(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? null;
    const semanticProgressAt = computeTaskSemanticProgressAt({
      state: taskState,
      taskEvents,
      lastVerificationAt,
    });
    if (semanticProgressAt === null || semanticProgressAt <= watchdogBlocker.createdAt) {
      return;
    }

    const resolved = this.resolveTaskBlocker(sessionId, WATCHDOG_BLOCKER_ID);
    if (!resolved.ok) {
      return;
    }
    const clearedAt = Date.now();
    const clearedPayload = buildTaskStuckClearedPayload({
      phase: resolveTaskWatchdogPhase(taskState) ?? "investigate",
      blockerId: WATCHDOG_BLOCKER_ID,
      detectedAt: watchdogBlocker.createdAt,
      clearedAt,
      resumedProgressAt: semanticProgressAt,
      openItemCount: getTaskWatchdogOpenItemCount(taskState),
    });

    this.recordEvent({
      sessionId,
      type: TASK_STUCK_CLEARED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      timestamp: clearedAt,
      payload: toTaskWatchdogEventPayload(clearedPayload),
    });
    this.taskDetectionKeyBySession.delete(sessionId);
  }
}
