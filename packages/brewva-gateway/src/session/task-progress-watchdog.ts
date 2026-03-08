import {
  SCAN_CONVERGENCE_BLOCKER_ID,
  TASK_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  WATCHDOG_BLOCKER_ID,
  WATCHDOG_BLOCKER_SOURCE,
  buildTaskStuckBlockerMessage,
  buildTaskStuckDetectedPayload,
  coerceTaskStuckDetectedPayload,
  computeTaskSemanticProgressAt,
  evaluateTaskWatchdogEligibility,
  getTaskWatchdogOpenItemCount,
  toTaskWatchdogEventPayload,
  type BrewvaRuntime,
  type TaskWatchdogPhase,
} from "@brewva/brewva-runtime";

type IntervalHandle = ReturnType<typeof setInterval>;
type TaskProgressWatchdogThresholdPolicy = Readonly<Record<TaskWatchdogPhase, number>>;

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLDS_MS: Record<TaskWatchdogPhase, number> = {
  investigate: 5 * 60_000,
  execute: 10 * 60_000,
  verify: 5 * 60_000,
};

export interface TaskProgressWatchdogOptions {
  runtime: BrewvaRuntime;
  sessionId: string;
  now?: () => number;
  pollIntervalMs?: number;
  thresholdsMs?: Partial<Record<TaskWatchdogPhase, number>>;
  setIntervalFn?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

function sanitizeDelayMs(value: number | undefined, fallbackMs: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallbackMs;
  return Math.max(1_000, candidate);
}

function createThresholdPolicy(
  overrides?: Partial<Record<TaskWatchdogPhase, number>>,
): TaskProgressWatchdogThresholdPolicy {
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

export class TaskProgressWatchdog {
  private readonly runtime: BrewvaRuntime;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly thresholdPolicy: TaskProgressWatchdogThresholdPolicy;
  private readonly setIntervalFn: TaskProgressWatchdogOptions["setIntervalFn"];
  private readonly clearIntervalFn: TaskProgressWatchdogOptions["clearIntervalFn"];
  private timer: IntervalHandle | null = null;
  // This is a per-process dedupe hint, not a distributed lock. The design assumes
  // one watchdog instance per session worker; event-store lookup covers restarts.
  private lastDetectionKey: string | null = null;

  constructor(options: TaskProgressWatchdogOptions) {
    this.runtime = options.runtime;
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = sanitizeDelayMs(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.thresholdPolicy = createThresholdPolicy(options.thresholdsMs);
    this.setIntervalFn =
      options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
  }

  start(): void {
    if (this.timer) return;
    this.timer =
      this.setIntervalFn?.(() => {
        this.poll();
      }, this.pollIntervalMs) ?? null;
    this.timer?.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn?.(this.timer);
    this.timer = null;
  }

  poll(): void {
    const taskState = this.runtime.task.getState(this.sessionId);
    const eligibility = evaluateTaskWatchdogEligibility(taskState);
    if (!eligibility.eligible || !eligibility.phase) {
      return;
    }

    const taskEvents = this.runtime.events.list(this.sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.runtime.events.query(this.sessionId, {
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

    const thresholdMs = this.thresholdPolicy[eligibility.phase];
    const detectedAt = this.now();
    const idleMs = Math.max(0, detectedAt - baselineProgressAt);
    if (idleMs < thresholdMs) {
      return;
    }

    const suppressedBy = eligibility.suppressedByBlockerId ?? null;
    if (suppressedBy === SCAN_CONVERGENCE_BLOCKER_ID && eligibility.hasWatchdogBlocker) {
      this.runtime.task.resolveBlocker(this.sessionId, WATCHDOG_BLOCKER_ID);
    }
    const detectionKey = buildDetectionKey({
      phase: eligibility.phase,
      baselineProgressAt,
      suppressedBy,
    });
    if (this.lastDetectionKey === detectionKey) {
      return;
    }

    const latestDetected = this.runtime.events.query(this.sessionId, {
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
      this.lastDetectionKey = detectionKey;
      return;
    }

    let blockerWritten = false;
    if (!suppressedBy && !eligibility.hasWatchdogBlocker) {
      const result = this.runtime.task.recordBlocker(this.sessionId, {
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

    this.runtime.events.record({
      sessionId: this.sessionId,
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      payload: toTaskWatchdogEventPayload(detectedPayload),
    });
    this.lastDetectionKey = detectionKey;
  }
}

export const TASK_PROGRESS_WATCHDOG_TEST_ONLY = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_THRESHOLDS_MS,
  createThresholdPolicy,
  sanitizeDelayMs,
  buildDetectionKey,
  SCAN_CONVERGENCE_BLOCKER_ID,
};
