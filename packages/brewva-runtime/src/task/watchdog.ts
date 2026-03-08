import {
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
} from "../events/event-types.js";
import type { BrewvaEventRecord, TaskBlocker, TaskPhase, TaskState } from "../types.js";
import { coerceTaskLedgerPayload } from "./ledger.js";

export const TASK_WATCHDOG_SCHEMA = "brewva.task-watchdog.v1" as const;
export const WATCHDOG_BLOCKER_ID = "watchdog:task-stuck:no-progress" as const;
export const WATCHDOG_BLOCKER_SOURCE = "runtime.watchdog" as const;
export const SCAN_CONVERGENCE_BLOCKER_ID = "guard:scan-convergence" as const;

export type TaskWatchdogPhase = Extract<TaskPhase, "investigate" | "execute" | "verify">;

export interface TaskStuckDetectedPayload {
  schema: typeof TASK_WATCHDOG_SCHEMA;
  phase: TaskWatchdogPhase;
  thresholdMs: number;
  baselineProgressAt: number;
  detectedAt: number;
  idleMs: number;
  openItemCount: number;
  blockerId: string | null;
  blockerWritten: boolean;
  suppressedBy: string | null;
}

export interface TaskStuckClearedPayload {
  schema: typeof TASK_WATCHDOG_SCHEMA;
  phase: TaskWatchdogPhase;
  blockerId: string;
  detectedAt: number;
  clearedAt: number;
  resumedProgressAt: number;
  openItemCount: number;
}

export interface TaskWatchdogEligibility {
  eligible: boolean;
  phase: TaskWatchdogPhase | null;
  hasWatchdogBlocker: boolean;
  suppressedByBlockerId?: string;
  reason?: "no_task_spec" | "inactive_phase" | "non_watchdog_blockers_present";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function maxTimestamp(current: number | null, next: number | null | undefined): number | null {
  if (typeof next !== "number" || !Number.isFinite(next) || next <= 0) {
    return current;
  }
  return current === null ? next : Math.max(current, next);
}

function countOpenItems(state: TaskState): number {
  return state.items.filter((item) => item.status !== "done").length;
}

export function inferUnderlyingTaskPhase(state: TaskState): TaskWatchdogPhase | null {
  if (!state.spec) return null;
  const openItemCount = countOpenItems(state);
  if (openItemCount > 0) {
    return "execute";
  }
  if (state.items.length === 0) {
    return "investigate";
  }
  return "verify";
}

export function resolveTaskWatchdogPhase(state: TaskState): TaskWatchdogPhase | null {
  const statusPhase = state.status?.phase;
  if (statusPhase === "investigate" || statusPhase === "execute" || statusPhase === "verify") {
    return statusPhase;
  }
  return inferUnderlyingTaskPhase(state);
}

export function getTaskWatchdogBlocker(state: TaskState): TaskBlocker | undefined {
  return state.blockers.find((blocker) => blocker.id === WATCHDOG_BLOCKER_ID);
}

export function getTaskWatchdogOpenItemCount(state: TaskState): number {
  return countOpenItems(state);
}

export function evaluateTaskWatchdogEligibility(state: TaskState): TaskWatchdogEligibility {
  if (!state.spec) {
    return {
      eligible: false,
      phase: null,
      hasWatchdogBlocker: false,
      reason: "no_task_spec",
    };
  }

  const hasWatchdogBlocker = Boolean(getTaskWatchdogBlocker(state));
  const hasScanConvergenceBlocker = state.blockers.some(
    (blocker) => blocker.id === SCAN_CONVERGENCE_BLOCKER_ID,
  );
  const otherBlockers = state.blockers.filter(
    (blocker) => blocker.id !== WATCHDOG_BLOCKER_ID && blocker.id !== SCAN_CONVERGENCE_BLOCKER_ID,
  );
  if (otherBlockers.length > 0) {
    return {
      eligible: false,
      phase: null,
      hasWatchdogBlocker,
      reason: "non_watchdog_blockers_present",
    };
  }

  const statusPhase = state.status?.phase;
  if (statusPhase === "align" || statusPhase === "done") {
    return {
      eligible: false,
      phase: null,
      hasWatchdogBlocker,
      reason: "inactive_phase",
    };
  }

  const phase = resolveTaskWatchdogPhase(state);
  if (!phase) {
    return {
      eligible: false,
      phase: null,
      hasWatchdogBlocker,
      reason: "inactive_phase",
    };
  }

  return {
    eligible: true,
    phase,
    hasWatchdogBlocker,
    suppressedByBlockerId: hasScanConvergenceBlocker ? SCAN_CONVERGENCE_BLOCKER_ID : undefined,
  };
}

export function computeTaskSemanticProgressAt(input: {
  state: TaskState;
  taskEvents: BrewvaEventRecord[];
  lastVerificationAt?: number | null;
}): number | null {
  let latest: number | null = null;

  for (const item of input.state.items) {
    latest = maxTimestamp(latest, item.updatedAt);
  }

  for (const blocker of input.state.blockers) {
    if (blocker.id === WATCHDOG_BLOCKER_ID) {
      continue;
    }
    latest = maxTimestamp(latest, blocker.createdAt);
  }

  latest = maxTimestamp(latest, input.lastVerificationAt ?? null);

  // Deliberately exclude status_set: task status can change from context/truth/budget
  // alignment without any task-ledger progress, and the watchdog should not reset on that.
  for (let index = input.taskEvents.length - 1; index >= 0; index -= 1) {
    const event = input.taskEvents[index];
    if (!event) continue;
    const payload = coerceTaskLedgerPayload(event.payload);
    if (!payload) continue;
    if (payload.kind === "spec_set") {
      latest = maxTimestamp(latest, event.timestamp);
      break;
    }
    if (payload.kind === "blocker_resolved" && payload.blockerId !== WATCHDOG_BLOCKER_ID) {
      latest = maxTimestamp(latest, event.timestamp);
      break;
    }
  }

  if (latest !== null) {
    return latest;
  }

  return typeof input.state.updatedAt === "number" && Number.isFinite(input.state.updatedAt)
    ? input.state.updatedAt
    : null;
}

export function buildTaskStuckBlockerMessage(input: {
  phase: TaskWatchdogPhase;
  idleMs: number;
  thresholdMs: number;
  baselineProgressAt: number;
  openItemCount: number;
}): string {
  return [
    "[TaskProgressWatchdog]",
    "No semantic task progress detected within the watchdog threshold.",
    `phase=${input.phase}`,
    `idle_ms=${input.idleMs}`,
    `threshold_ms=${input.thresholdMs}`,
    `open_items=${input.openItemCount}`,
    `last_progress_at=${input.baselineProgressAt}`,
    "required_next_step=Summarize current evidence, record blocker/root cause, or change strategy before continuing.",
  ].join("\n");
}

export function buildTaskStuckDetectedPayload(
  input: Omit<TaskStuckDetectedPayload, "schema">,
): TaskStuckDetectedPayload {
  return {
    schema: TASK_WATCHDOG_SCHEMA,
    ...input,
  };
}

export function buildTaskStuckClearedPayload(
  input: Omit<TaskStuckClearedPayload, "schema">,
): TaskStuckClearedPayload {
  return {
    schema: TASK_WATCHDOG_SCHEMA,
    ...input,
  };
}

export function toTaskWatchdogEventPayload(
  payload: TaskStuckDetectedPayload | TaskStuckClearedPayload,
): Record<string, unknown> {
  return { ...payload };
}

export function coerceTaskStuckDetectedPayload(value: unknown): TaskStuckDetectedPayload | null {
  if (!isRecord(value) || value.schema !== TASK_WATCHDOG_SCHEMA) {
    return null;
  }
  if (value.phase !== "investigate" && value.phase !== "execute" && value.phase !== "verify") {
    return null;
  }
  const thresholdMs = Number(value.thresholdMs);
  const baselineProgressAt = Number(value.baselineProgressAt);
  const detectedAt = Number(value.detectedAt);
  const idleMs = Number(value.idleMs);
  const openItemCount = Number(value.openItemCount);
  if (
    !Number.isFinite(thresholdMs) ||
    !Number.isFinite(baselineProgressAt) ||
    !Number.isFinite(detectedAt) ||
    !Number.isFinite(idleMs) ||
    !Number.isFinite(openItemCount)
  ) {
    return null;
  }
  const blockerId = typeof value.blockerId === "string" ? value.blockerId : null;
  const suppressedBy = typeof value.suppressedBy === "string" ? value.suppressedBy : null;
  return {
    schema: TASK_WATCHDOG_SCHEMA,
    phase: value.phase,
    thresholdMs,
    baselineProgressAt,
    detectedAt,
    idleMs,
    openItemCount,
    blockerId,
    blockerWritten: value.blockerWritten === true,
    suppressedBy,
  };
}

export function isTaskWatchdogEventType(type: string): boolean {
  return type === TASK_STUCK_DETECTED_EVENT_TYPE || type === TASK_STUCK_CLEARED_EVENT_TYPE;
}
