import { resolve } from "node:path";
import { addMilliseconds, subMilliseconds } from "date-fns";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaStructuredEvent,
  ConvergencePredicate,
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentEventPayload,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
  TaskState,
  TruthState,
} from "../types.js";
import {
  getNextCronRunAt,
  normalizeTimeZone,
  parseCronExpression,
  type ParsedCronExpression,
} from "./cron.js";
import {
  SCHEDULE_EVENT_TYPE,
  buildScheduleIntentCancelledEvent,
  buildScheduleIntentConvergedEvent,
  buildScheduleIntentCreatedEvent,
  buildScheduleIntentFiredEvent,
  buildScheduleIntentUpdatedEvent,
  parseScheduleIntentEvent,
} from "./events.js";
import { ScheduleProjectionStore } from "./projection.js";

type TimerHandle = unknown;

function sortEventsByTime(left: BrewvaEventRecord, right: BrewvaEventRecord): number {
  // Keep comparator timestamp-only so stable sort preserves append order when timestamps collide.
  return left.timestamp - right.timestamp;
}

function generateIntentId(now: number): string {
  return `intent_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function detectDefaultCronTimeZone(): string {
  const resolved = normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
  return resolved ?? "UTC";
}

function projectionEquivalent(
  left: ScheduleProjectionSnapshot | null,
  right: ScheduleProjectionSnapshot,
): boolean {
  if (!left) return false;
  if (left.watermarkOffset !== right.watermarkOffset) return false;
  if (left.intents.length !== right.intents.length) return false;

  for (let index = 0; index < left.intents.length; index += 1) {
    const leftIntent = left.intents[index];
    const rightIntent = right.intents[index];
    if (!leftIntent || !rightIntent) return false;
    if (JSON.stringify(leftIntent) !== JSON.stringify(rightIntent)) return false;
  }
  return true;
}

function normalizeMaxRuns(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeConvergenceCondition(
  value: ConvergencePredicate | undefined,
): ConvergencePredicate | undefined {
  if (!value) return undefined;
  return value;
}

export interface SchedulerRecoverResult {
  snapshot: ScheduleProjectionSnapshot;
  projectionMatched: boolean;
  rebuiltFromEvents: number;
  catchUp: SchedulerCatchUpSummary;
}

export interface SchedulerCatchUpSessionSummary {
  parentSessionId: string;
  dueIntents: number;
  firedIntents: number;
  deferredIntents: number;
}

export interface SchedulerCatchUpSummary {
  dueIntents: number;
  firedIntents: number;
  deferredIntents: number;
  sessions: SchedulerCatchUpSessionSummary[];
}

export interface SchedulerRuntimePort {
  workspaceRoot: string;
  scheduleConfig: BrewvaConfig["schedule"];
  listSessionIds(): string[];
  listEvents(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): BrewvaEventRecord | undefined;
  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void;
  getTruthState(sessionId: string): TruthState;
  getTaskState(sessionId: string): TaskState;
}

interface SchedulerLegacyRuntimePort {
  workspaceRoot: string;
  config: Pick<BrewvaConfig, "schedule">;
  events: {
    listSessionIds(): string[];
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  };
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): BrewvaEventRecord | undefined;
  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void;
  getTruthState(sessionId: string): TruthState;
  getTaskState(sessionId: string): TaskState;
}

function toSchedulerRuntimePort(
  runtime: SchedulerRuntimePort | SchedulerLegacyRuntimePort,
): SchedulerRuntimePort {
  if ("scheduleConfig" in runtime) {
    return runtime;
  }

  return {
    workspaceRoot: runtime.workspaceRoot,
    scheduleConfig: runtime.config.schedule,
    listSessionIds: () => runtime.events.listSessionIds(),
    listEvents: (sessionId, query) => runtime.events.list(sessionId, query),
    recordEvent: (input) => runtime.recordEvent(input),
    subscribeEvents: (listener) => runtime.subscribeEvents(listener),
    getTruthState: (sessionId) => runtime.getTruthState(sessionId),
    getTaskState: (sessionId) => runtime.getTaskState(sessionId),
  };
}

export interface SchedulerServiceOptions {
  runtime: SchedulerRuntimePort | SchedulerLegacyRuntimePort;
  enableExecution?: boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  executeIntent?: (
    intent: ScheduleIntentProjectionRecord,
  ) => Promise<ScheduleIntentExecutionResult | void> | ScheduleIntentExecutionResult | void;
}

export interface ScheduleIntentExecutionResult {
  evaluationSessionId?: string;
  nextRunAt?: number;
}

export interface SchedulerStats {
  intentsTotal: number;
  intentsActive: number;
  timersArmed: number;
  watermarkOffset: number;
  projectionPath: string;
  executionEnabled: boolean;
}

export class SchedulerService {
  private readonly runtimePort: SchedulerRuntimePort;
  private readonly enableExecution: boolean;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly executeIntent: (
    intent: ScheduleIntentProjectionRecord,
  ) => Promise<ScheduleIntentExecutionResult | void>;
  private readonly projectionStore: ScheduleProjectionStore;
  private readonly defaultCronTimeZone: string;

  private readonly intentsById = new Map<string, ScheduleIntentProjectionRecord>();
  private readonly timersByIntentId = new Map<string, TimerHandle>();
  private readonly fireInProgress = new Set<string>();
  private readonly parsedCronBySource = new Map<string, ParsedCronExpression>();
  private readonly selfEmittedEventIds = new Set<string>();
  private watermarkOffset = 0;
  private unsubscribeRuntimeEvents: (() => void) | null = null;

  constructor(options: SchedulerServiceOptions) {
    this.runtimePort = toSchedulerRuntimePort(options.runtime);
    this.enableExecution =
      options.enableExecution !== false && typeof options.executeIntent === "function";
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.executeIntent = async (intent) => {
      if (options.executeIntent) {
        return await options.executeIntent(intent);
      }
      return undefined;
    };

    const projectionPath = resolve(
      this.runtimePort.workspaceRoot,
      this.runtimePort.scheduleConfig.projectionPath,
    );
    this.projectionStore = new ScheduleProjectionStore(projectionPath);
    this.defaultCronTimeZone = detectDefaultCronTimeZone();
  }

  getProjectionPath(): string {
    return this.projectionStore.filePath;
  }

  snapshot(): ScheduleProjectionSnapshot {
    return this.buildSnapshot(this.now());
  }

  getStats(): SchedulerStats {
    const intents = [...this.intentsById.values()];
    const intentsActive = intents.filter((intent) => intent.status === "active").length;
    return {
      intentsTotal: intents.length,
      intentsActive,
      timersArmed: this.timersByIntentId.size,
      watermarkOffset: this.watermarkOffset,
      projectionPath: this.getProjectionPath(),
      executionEnabled: this.enableExecution,
    };
  }

  stop(): void {
    if (this.unsubscribeRuntimeEvents) {
      this.unsubscribeRuntimeEvents();
      this.unsubscribeRuntimeEvents = null;
    }
    for (const timer of this.timersByIntentId.values()) {
      this.clearTimer(timer);
    }
    this.timersByIntentId.clear();
  }

  async recover(): Promise<SchedulerRecoverResult> {
    this.stop();

    const previousProjection = this.projectionStore.load();
    this.intentsById.clear();

    const scheduleEvents = this.collectScheduleEvents();
    this.watermarkOffset = 0;
    for (let index = 0; index < scheduleEvents.length; index += 1) {
      const row = scheduleEvents[index];
      if (!row) continue;
      const payload = parseScheduleIntentEvent(row);
      if (!payload) continue;
      this.watermarkOffset = index + 1;
      this.applyScheduleEvent(payload, row.timestamp, this.watermarkOffset);
    }

    this.clearExpiredLeases(this.now());
    const snapshot = this.persistProjection(this.now());
    const projectionMatched = projectionEquivalent(previousProjection, snapshot);

    let catchUp: SchedulerCatchUpSummary = {
      dueIntents: 0,
      firedIntents: 0,
      deferredIntents: 0,
      sessions: [],
    };
    if (this.enableExecution) {
      catchUp = await this.catchUpMissedRuns();
      this.emitRecoverySummaryEvents(catchUp, this.now());
      this.armAllTimers();
      this.subscribeRuntimeEvents();
    }
    return {
      snapshot: this.buildSnapshot(this.now()),
      projectionMatched,
      rebuiltFromEvents: scheduleEvents.length,
      catchUp,
    };
  }

  createIntent(
    input: ScheduleIntentCreateInput & { parentSessionId: string },
  ): ScheduleIntentCreateResult {
    if (!this.runtimePort.scheduleConfig.enabled) {
      return { ok: false, error: "scheduler_disabled" };
    }
    const parentSessionId = normalizeOptionalString(input.parentSessionId);
    if (!parentSessionId) {
      return { ok: false, error: "missing_parent_session_id" };
    }

    const reason = normalizeOptionalString(input.reason);
    if (!reason) {
      return { ok: false, error: "missing_reason" };
    }

    const normalizedCron = normalizeOptionalString(input.cron);
    const hasRunAt = input.runAt !== undefined;
    const hasCron = normalizedCron !== undefined;
    const normalizedTimeZoneInput = normalizeOptionalString(input.timeZone);
    if (input.cron !== undefined && !hasCron) {
      return { ok: false, error: "invalid_cron" };
    }
    if (input.timeZone !== undefined && !normalizedTimeZoneInput) {
      return { ok: false, error: "invalid_time_zone" };
    }

    if (!hasRunAt && !hasCron) {
      return { ok: false, error: "missing_schedule_target" };
    }
    if (hasRunAt && hasCron) {
      return { ok: false, error: "runAt_and_cron_are_mutually_exclusive" };
    }
    if (hasRunAt && normalizedTimeZoneInput) {
      return { ok: false, error: "timeZone_requires_cron" };
    }
    const now = this.now();
    let normalizedRunAt: number | undefined;
    let normalizedNextRunAt: number | undefined;
    let normalizedTimeZone: string | undefined;

    if (hasCron) {
      const cron = normalizedCron;
      if (!cron) {
        return { ok: false, error: "invalid_cron" };
      }
      normalizedTimeZone = normalizedTimeZoneInput
        ? normalizeTimeZone(normalizedTimeZoneInput)
        : this.defaultCronTimeZone;
      if (!normalizedTimeZone) {
        return { ok: false, error: "invalid_time_zone" };
      }
      const parsedCron = parseCronExpression(cron);
      if (!parsedCron.ok) {
        return { ok: false, error: "invalid_cron" };
      }
      this.parsedCronBySource.set(cron, parsedCron.expression);
      const minBase = subMilliseconds(
        addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs),
        1,
      ).getTime();
      normalizedNextRunAt = this.computeCronNextRunAt(cron, minBase, normalizedTimeZone);
      if (normalizedNextRunAt === undefined) {
        return { ok: false, error: "cron_has_no_future_match" };
      }
    } else {
      if (typeof input.runAt !== "number" || !Number.isFinite(input.runAt) || input.runAt <= now) {
        return { ok: false, error: "invalid_runAt" };
      }
      const minRunAt = addMilliseconds(
        now,
        this.runtimePort.scheduleConfig.minIntervalMs,
      ).getTime();
      normalizedRunAt = Math.max(Math.floor(input.runAt), minRunAt);
      normalizedNextRunAt = normalizedRunAt;
    }

    const activeIntents = [...this.intentsById.values()].filter(
      (intent) => intent.status === "active",
    );
    if (activeIntents.length >= this.runtimePort.scheduleConfig.maxActiveIntentsGlobal) {
      return { ok: false, error: "max_active_intents_global_exceeded" };
    }
    const activeInSession = activeIntents.filter(
      (intent) => intent.parentSessionId === parentSessionId,
    ).length;
    if (activeInSession >= this.runtimePort.scheduleConfig.maxActiveIntentsPerSession) {
      return { ok: false, error: "max_active_intents_per_session_exceeded" };
    }

    const maxRuns = normalizeMaxRuns(input.maxRuns, hasCron ? 10_000 : 1);
    const continuityMode = input.continuityMode ?? "inherit";
    const intentId = normalizeOptionalString(input.intentId) ?? generateIntentId(now);
    if (this.intentsById.has(intentId)) {
      return { ok: false, error: "intent_id_already_exists" };
    }

    const payload = buildScheduleIntentCreatedEvent({
      intentId,
      parentSessionId,
      reason,
      goalRef: normalizeOptionalString(input.goalRef),
      continuityMode,
      runAt: normalizedRunAt,
      cron: normalizedCron,
      timeZone: normalizedTimeZone,
      nextRunAt: normalizedNextRunAt,
      maxRuns,
      convergenceCondition: normalizeConvergenceCondition(input.convergenceCondition),
    });

    const appended = this.appendScheduleEvent(payload);
    if (!appended) {
      return { ok: false, error: "events_store_disabled" };
    }

    const intent = this.intentsById.get(intentId);
    if (!intent) return { ok: false, error: "intent_persist_failed" };
    if (this.enableExecution) {
      this.armTimer(intent);
    }
    return { ok: true, intent };
  }

  cancelIntent(
    input: ScheduleIntentCancelInput & { parentSessionId: string },
  ): ScheduleIntentCancelResult {
    const parentSessionId = normalizeOptionalString(input.parentSessionId);
    if (!parentSessionId) return { ok: false, error: "missing_parent_session_id" };
    const intentId = normalizeOptionalString(input.intentId);
    if (!intentId) return { ok: false, error: "missing_intent_id" };

    const intent = this.intentsById.get(intentId);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.parentSessionId !== parentSessionId)
      return { ok: false, error: "intent_owner_mismatch" };
    if (intent.status !== "active") return { ok: false, error: "intent_not_active" };

    const payload = buildScheduleIntentCancelledEvent({
      intentId: intent.intentId,
      parentSessionId: intent.parentSessionId,
      reason: normalizeOptionalString(input.reason) ?? intent.reason,
      goalRef: intent.goalRef,
      continuityMode: intent.continuityMode,
      runAt: intent.runAt,
      cron: intent.cron,
      timeZone: intent.timeZone,
      maxRuns: intent.maxRuns,
      convergenceCondition: intent.convergenceCondition,
    });
    const appended = this.appendScheduleEvent(payload);
    if (!appended) return { ok: false, error: "events_store_disabled" };
    this.clearTimerForIntent(intentId);
    return { ok: true };
  }

  updateIntent(
    input: ScheduleIntentUpdateInput & { parentSessionId: string },
  ): ScheduleIntentUpdateResult {
    const parentSessionId = normalizeOptionalString(input.parentSessionId);
    if (!parentSessionId) return { ok: false, error: "missing_parent_session_id" };
    const intentId = normalizeOptionalString(input.intentId);
    if (!intentId) return { ok: false, error: "missing_intent_id" };

    const intent = this.intentsById.get(intentId);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.parentSessionId !== parentSessionId)
      return { ok: false, error: "intent_owner_mismatch" };
    const canReactivate =
      intent.status === "converged" &&
      typeof input.maxRuns === "number" &&
      input.maxRuns > intent.runCount;
    if (intent.status !== "active" && !canReactivate)
      return { ok: false, error: "intent_not_active" };

    const now = this.now();
    const hasRunAt = input.runAt !== undefined;
    const hasCronInput = input.cron !== undefined;
    const normalizedCronInput = normalizeOptionalString(input.cron);
    const normalizedTimeZoneInput = normalizeOptionalString(input.timeZone);

    if (hasRunAt && hasCronInput) {
      return { ok: false, error: "runAt_and_cron_are_mutually_exclusive" };
    }
    if (input.timeZone !== undefined && !normalizedTimeZoneInput) {
      return { ok: false, error: "invalid_time_zone" };
    }
    if (hasCronInput && !normalizedCronInput) {
      return { ok: false, error: "invalid_cron" };
    }
    if (hasRunAt && normalizedTimeZoneInput) {
      return { ok: false, error: "timeZone_requires_cron" };
    }

    const normalizedReasonInput = normalizeOptionalString(input.reason);
    if (input.reason !== undefined && !normalizedReasonInput) {
      return { ok: false, error: "invalid_reason" };
    }

    let nextRunAt = intent.nextRunAt;
    let runAt = intent.runAt;
    let cron = intent.cron;
    let timeZone = intent.timeZone;

    if (hasRunAt) {
      if (typeof input.runAt !== "number" || !Number.isFinite(input.runAt) || input.runAt <= now) {
        return { ok: false, error: "invalid_runAt" };
      }
      const minRunAt = addMilliseconds(
        now,
        this.runtimePort.scheduleConfig.minIntervalMs,
      ).getTime();
      runAt = Math.max(Math.floor(input.runAt), minRunAt);
      cron = undefined;
      timeZone = undefined;
      nextRunAt = runAt;
    } else if (hasCronInput) {
      const nextCron = normalizedCronInput;
      if (!nextCron) {
        return { ok: false, error: "invalid_cron" };
      }
      const parsedCron = parseCronExpression(nextCron);
      if (!parsedCron.ok) {
        return { ok: false, error: "invalid_cron" };
      }
      this.parsedCronBySource.set(nextCron, parsedCron.expression);
      const nextTimeZone = normalizedTimeZoneInput
        ? normalizeTimeZone(normalizedTimeZoneInput)
        : (timeZone ?? this.defaultCronTimeZone);
      if (!nextTimeZone) {
        return { ok: false, error: "invalid_time_zone" };
      }
      const minBase = subMilliseconds(
        addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs),
        1,
      ).getTime();
      const nextRunAtForCron = this.computeCronNextRunAt(nextCron, minBase, nextTimeZone);
      if (nextRunAtForCron === undefined) {
        return { ok: false, error: "cron_has_no_future_match" };
      }

      cron = nextCron;
      timeZone = nextTimeZone;
      runAt = undefined;
      nextRunAt = nextRunAtForCron;
    } else if (normalizedTimeZoneInput) {
      if (!cron) {
        return { ok: false, error: "timeZone_requires_cron" };
      }
      const nextTimeZone = normalizeTimeZone(normalizedTimeZoneInput);
      if (!nextTimeZone) {
        return { ok: false, error: "invalid_time_zone" };
      }
      const minBase = subMilliseconds(
        addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs),
        1,
      ).getTime();
      const nextRunAtForCron = this.computeCronNextRunAt(cron, minBase, nextTimeZone);
      if (nextRunAtForCron === undefined) {
        return { ok: false, error: "cron_has_no_future_match" };
      }
      timeZone = nextTimeZone;
      nextRunAt = nextRunAtForCron;
    }

    const continuityMode = input.continuityMode ?? intent.continuityMode;
    const maxRuns = normalizeMaxRuns(input.maxRuns, intent.maxRuns);
    const goalRef =
      input.goalRef !== undefined ? normalizeOptionalString(input.goalRef) : intent.goalRef;
    const convergenceCondition =
      input.convergenceCondition !== undefined
        ? normalizeConvergenceCondition(input.convergenceCondition)
        : intent.convergenceCondition;

    if (maxRuns <= intent.runCount) {
      nextRunAt = undefined;
    } else if (maxRuns > intent.runCount && nextRunAt === undefined) {
      if (cron) {
        const minBase = subMilliseconds(
          addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs),
          1,
        ).getTime();
        nextRunAt = this.computeCronNextRunAt(cron, minBase, timeZone);
        if (nextRunAt === undefined) {
          return { ok: false, error: "cron_has_no_future_match" };
        }
      } else {
        nextRunAt = addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs).getTime();
      }
    }

    const payload = buildScheduleIntentUpdatedEvent({
      intentId: intent.intentId,
      parentSessionId: intent.parentSessionId,
      reason: normalizedReasonInput ?? intent.reason,
      goalRef,
      continuityMode,
      runAt,
      cron,
      timeZone,
      nextRunAt,
      maxRuns,
      convergenceCondition,
    });
    const appended = this.appendScheduleEvent(payload);
    if (!appended) return { ok: false, error: "events_store_disabled" };

    const updated = this.intentsById.get(intentId);
    if (!updated) return { ok: false, error: "intent_persist_failed" };
    if (this.enableExecution) {
      this.armTimer(updated);
    }
    return { ok: true, intent: updated };
  }

  listIntents(query: ScheduleIntentListQuery = {}): ScheduleIntentProjectionRecord[] {
    return [...this.intentsById.values()]
      .filter((intent) => {
        if (query.parentSessionId && intent.parentSessionId !== query.parentSessionId) return false;
        if (query.status && intent.status !== query.status) return false;
        return true;
      })
      .toSorted((left, right) => {
        if (left.updatedAt !== right.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.intentId.localeCompare(right.intentId);
      });
  }

  private collectScheduleEvents(): BrewvaEventRecord[] {
    const sessionIds = this.runtimePort.listSessionIds();
    const rows: BrewvaEventRecord[] = [];
    for (const sessionId of sessionIds) {
      rows.push(...this.runtimePort.listEvents(sessionId, { type: SCHEDULE_EVENT_TYPE }));
    }
    return rows.toSorted(sortEventsByTime);
  }

  private appendScheduleEvent(payload: ScheduleIntentEventPayload): BrewvaEventRecord | null {
    const row = this.runtimePort.recordEvent({
      sessionId: payload.parentSessionId,
      type: SCHEDULE_EVENT_TYPE,
      payload: payload as unknown as Record<string, unknown>,
      skipTapeCheckpoint: true,
    });
    if (!row) return null;

    this.selfEmittedEventIds.add(row.id);
    this.watermarkOffset += 1;
    this.applyScheduleEvent(payload, row.timestamp, this.watermarkOffset);
    this.persistProjection(row.timestamp);
    return row;
  }

  private applyScheduleEvent(
    payload: ScheduleIntentEventPayload,
    timestamp: number,
    eventOffset: number,
  ): void {
    const normalizedCron = normalizeOptionalString(payload.cron);
    const normalizedTimeZone = normalizedCron
      ? (normalizeTimeZone(payload.timeZone ?? "") ?? this.defaultCronTimeZone)
      : undefined;
    const nextRunAtFromCreate =
      payload.nextRunAt ??
      payload.runAt ??
      (normalizedCron
        ? this.computeCronNextRunAt(
            normalizedCron,
            subMilliseconds(
              addMilliseconds(timestamp, this.runtimePort.scheduleConfig.minIntervalMs),
              1,
            ).getTime(),
            normalizedTimeZone,
          )
        : undefined);
    const existing = this.intentsById.get(payload.intentId);
    const record =
      existing ??
      ({
        intentId: payload.intentId,
        parentSessionId: payload.parentSessionId,
        reason: payload.reason,
        goalRef: payload.goalRef,
        continuityMode: payload.continuityMode,
        cron: normalizedCron,
        timeZone: normalizedTimeZone,
        runAt: payload.runAt,
        maxRuns: normalizeMaxRuns(payload.maxRuns, normalizedCron ? 10_000 : 1),
        runCount: 0,
        nextRunAt: nextRunAtFromCreate,
        status: "active",
        convergenceCondition: payload.convergenceCondition,
        consecutiveErrors: 0,
        leaseUntilMs: undefined,
        lastError: undefined,
        lastEvaluationSessionId: undefined,
        updatedAt: timestamp,
        eventOffset,
      } satisfies ScheduleIntentProjectionRecord);

    record.parentSessionId = payload.parentSessionId;
    record.reason = payload.reason;
    record.goalRef = payload.goalRef;
    record.continuityMode = payload.continuityMode;
    record.cron = normalizedCron;
    record.timeZone = normalizedTimeZone;
    record.runAt = payload.runAt;
    record.maxRuns = normalizeMaxRuns(payload.maxRuns, record.maxRuns || 1);
    record.convergenceCondition = payload.convergenceCondition;

    if (payload.kind === "intent_created") {
      record.status = "active";
      record.runCount = 0;
      record.nextRunAt = nextRunAtFromCreate;
      record.consecutiveErrors = 0;
      record.lastError = undefined;
      record.leaseUntilMs = undefined;
    } else if (payload.kind === "intent_updated") {
      record.status = "active";
      record.nextRunAt = payload.nextRunAt;
      record.leaseUntilMs = undefined;
    } else if (payload.kind === "intent_cancelled") {
      record.status = payload.error ? "error" : "cancelled";
      record.nextRunAt = undefined;
      record.leaseUntilMs = undefined;
      if (payload.error) {
        record.lastError = payload.error;
      }
    } else if (payload.kind === "intent_converged") {
      record.status = "converged";
      record.nextRunAt = undefined;
      record.leaseUntilMs = undefined;
      record.consecutiveErrors = 0;
    } else if (payload.kind === "intent_fired") {
      const nextRunIndex = payload.runIndex ?? record.runCount + 1;
      record.runCount = Math.max(record.runCount, nextRunIndex);
      record.nextRunAt = payload.nextRunAt;
      if (payload.childSessionId) {
        record.lastEvaluationSessionId = payload.childSessionId;
      }
      record.leaseUntilMs = undefined;
      if (payload.error) {
        record.consecutiveErrors = record.consecutiveErrors + 1;
        record.lastError = payload.error;
      } else {
        record.consecutiveErrors = 0;
        record.lastError = undefined;
      }
    }

    if (record.status === "active" && record.runCount >= record.maxRuns) {
      record.status = "converged";
      record.nextRunAt = undefined;
      record.leaseUntilMs = undefined;
    }

    record.updatedAt = timestamp;
    record.eventOffset = eventOffset;
    this.intentsById.set(record.intentId, record);
  }

  private clearExpiredLeases(now: number): void {
    for (const intent of this.intentsById.values()) {
      if (intent.status !== "active") continue;
      if (intent.leaseUntilMs !== undefined && intent.leaseUntilMs <= now) {
        intent.leaseUntilMs = undefined;
      }
    }
  }

  private persistProjection(now: number): ScheduleProjectionSnapshot {
    const snapshot = this.buildSnapshot(now);
    this.projectionStore.save(snapshot);
    return snapshot;
  }

  private buildSnapshot(now: number): ScheduleProjectionSnapshot {
    return {
      schema: "brewva.schedule.projection.v1",
      generatedAt: now,
      watermarkOffset: this.watermarkOffset,
      intents: [...this.intentsById.values()].toSorted((left, right) =>
        left.intentId.localeCompare(right.intentId),
      ),
    };
  }

  private subscribeRuntimeEvents(): void {
    if (this.unsubscribeRuntimeEvents) return;
    this.unsubscribeRuntimeEvents = this.runtimePort.subscribeEvents((event) => {
      if (event.type !== SCHEDULE_EVENT_TYPE) return;
      if (this.selfEmittedEventIds.delete(event.id)) return;

      const payload = parseScheduleIntentEvent({
        id: event.id,
        sessionId: event.sessionId,
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
      });
      if (!payload) return;

      this.watermarkOffset += 1;
      this.applyScheduleEvent(payload, event.timestamp, this.watermarkOffset);
      this.persistProjection(event.timestamp);

      const updated = this.intentsById.get(payload.intentId);
      if (updated && this.enableExecution) {
        this.armTimer(updated);
      }
    });
  }

  private armAllTimers(): void {
    for (const timer of this.timersByIntentId.values()) {
      this.clearTimer(timer);
    }
    this.timersByIntentId.clear();
    for (const intent of this.intentsById.values()) {
      this.armTimer(intent);
    }
  }

  private armTimer(intent: ScheduleIntentProjectionRecord): void {
    this.clearTimerForIntent(intent.intentId);
    if (intent.status !== "active") return;
    if (typeof intent.nextRunAt !== "number" || !Number.isFinite(intent.nextRunAt)) return;

    const delayMs = Math.max(0, intent.nextRunAt - this.now());
    const handle = this.setTimer(() => {
      void this.fireIntent(intent.intentId);
    }, delayMs);
    this.timersByIntentId.set(intent.intentId, handle);
  }

  private clearTimerForIntent(intentId: string): void {
    const timer = this.timersByIntentId.get(intentId);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.timersByIntentId.delete(intentId);
  }

  private deferIntentAfterRecovery(input: {
    intent: ScheduleIntentProjectionRecord;
    now: number;
    sequence: number;
    backlogSize: number;
  }): boolean {
    const deferredFrom = input.intent.nextRunAt;
    const deferredTo = addMilliseconds(
      input.now,
      this.runtimePort.scheduleConfig.minIntervalMs * input.sequence,
    ).getTime();

    const payload = buildScheduleIntentUpdatedEvent({
      intentId: input.intent.intentId,
      parentSessionId: input.intent.parentSessionId,
      reason: input.intent.reason,
      goalRef: input.intent.goalRef,
      continuityMode: input.intent.continuityMode,
      runAt: input.intent.runAt,
      cron: input.intent.cron,
      timeZone: input.intent.timeZone,
      nextRunAt: deferredTo,
      maxRuns: input.intent.maxRuns,
      convergenceCondition: input.intent.convergenceCondition,
    });
    const appended = this.appendScheduleEvent(payload);
    if (!appended) return false;

    this.runtimePort.recordEvent({
      sessionId: input.intent.parentSessionId,
      type: "schedule_recovery_deferred",
      payload: {
        schema: "brewva.schedule-recovery.v1",
        intentId: input.intent.intentId,
        reason: "max_recovery_catchups_exceeded",
        deferredFrom: deferredFrom ?? null,
        deferredTo,
        queueSequence: input.sequence,
        backlogSize: input.backlogSize,
      },
      skipTapeCheckpoint: true,
    });
    return true;
  }

  private emitRecoverySummaryEvents(catchUp: SchedulerCatchUpSummary, recoveredAt: number): void {
    if (catchUp.dueIntents <= 0) return;
    for (const session of catchUp.sessions) {
      if (session.dueIntents <= 0) continue;
      this.runtimePort.recordEvent({
        sessionId: session.parentSessionId,
        type: "schedule_recovery_summary",
        payload: {
          schema: "brewva.schedule-recovery.v1",
          recoveredAt,
          parentSessionId: session.parentSessionId,
          dueIntents: session.dueIntents,
          firedIntents: session.firedIntents,
          deferredIntents: session.deferredIntents,
          maxRecoveryCatchUps: this.runtimePort.scheduleConfig.maxRecoveryCatchUps,
        },
        skipTapeCheckpoint: true,
      });
    }
  }

  private async catchUpMissedRuns(): Promise<SchedulerCatchUpSummary> {
    const now = this.now();
    const limit = this.runtimePort.scheduleConfig.maxRecoveryCatchUps;
    const due = [...this.intentsById.values()]
      .filter(
        (intent) =>
          intent.status === "active" &&
          typeof intent.nextRunAt === "number" &&
          intent.nextRunAt <= now,
      )
      .toSorted((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0));

    const sessions = new Map<string, SchedulerCatchUpSessionSummary>();
    for (const intent of due) {
      const existing = sessions.get(intent.parentSessionId);
      if (existing) {
        existing.dueIntents += 1;
      } else {
        sessions.set(intent.parentSessionId, {
          parentSessionId: intent.parentSessionId,
          dueIntents: 1,
          firedIntents: 0,
          deferredIntents: 0,
        });
      }
    }

    const toFire: ScheduleIntentProjectionRecord[] = [];
    if (limit > 0) {
      const queueBySession = new Map<string, ScheduleIntentProjectionRecord[]>();
      const sessionOrder: string[] = [];
      for (const intent of due) {
        const queue = queueBySession.get(intent.parentSessionId);
        if (queue) {
          queue.push(intent);
        } else {
          queueBySession.set(intent.parentSessionId, [intent]);
          sessionOrder.push(intent.parentSessionId);
        }
      }

      let progressed = true;
      while (toFire.length < limit && progressed) {
        progressed = false;
        for (const parentSessionId of sessionOrder) {
          if (toFire.length >= limit) break;
          const queue = queueBySession.get(parentSessionId);
          const nextIntent = queue?.shift();
          if (!nextIntent) continue;
          toFire.push(nextIntent);
          progressed = true;
        }
      }
    }
    const firedIntentIds = new Set(toFire.map((intent) => intent.intentId));
    const overflow = due.filter((intent) => !firedIntentIds.has(intent.intentId));

    for (const intent of toFire) {
      await this.fireIntent(intent.intentId);
      const summary = sessions.get(intent.parentSessionId);
      if (summary) {
        summary.firedIntents += 1;
      }
    }
    let deferredIntents = 0;
    for (let index = 0; index < overflow.length; index += 1) {
      const intent = overflow[index];
      if (!intent) continue;
      if (
        this.deferIntentAfterRecovery({
          intent,
          now,
          sequence: index + 1,
          backlogSize: overflow.length,
        })
      ) {
        deferredIntents += 1;
        const summary = sessions.get(intent.parentSessionId);
        if (summary) {
          summary.deferredIntents += 1;
        }
      }
    }

    return {
      dueIntents: due.length,
      firedIntents: toFire.length,
      deferredIntents,
      sessions: [...sessions.values()].toSorted((left, right) =>
        left.parentSessionId.localeCompare(right.parentSessionId),
      ),
    };
  }

  private computeRetryBackoffMs(consecutiveErrors: number): number {
    const base = this.runtimePort.scheduleConfig.minIntervalMs;
    const multiplier = 2 ** Math.max(0, consecutiveErrors - 1);
    const capMs = 60 * 60 * 1000;
    return Math.min(capMs, base * multiplier);
  }

  private normalizeExecutionNextRunAt(value: number | undefined, now: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    const minimum = addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs).getTime();
    return Math.max(Math.floor(value), minimum);
  }

  private resolveParsedCron(cronExpression: string): ParsedCronExpression | undefined {
    const cached = this.parsedCronBySource.get(cronExpression);
    if (cached) return cached;

    const parsed = parseCronExpression(cronExpression);
    if (!parsed.ok) return undefined;
    this.parsedCronBySource.set(cronExpression, parsed.expression);
    return parsed.expression;
  }

  private computeCronNextRunAt(
    cronExpression: string,
    afterMs: number,
    timeZone?: string,
  ): number | undefined {
    const parsed = this.resolveParsedCron(cronExpression);
    if (!parsed) return undefined;
    const normalizedTimeZone = timeZone ? normalizeTimeZone(timeZone) : undefined;
    if (!normalizedTimeZone) {
      return getNextCronRunAt(parsed, afterMs);
    }
    const currentLocalTimeZone = normalizeTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    );
    if (currentLocalTimeZone && currentLocalTimeZone === normalizedTimeZone) {
      return getNextCronRunAt(parsed, afterMs);
    }
    return getNextCronRunAt(parsed, afterMs, { timeZone: normalizedTimeZone });
  }

  private evaluateConvergencePredicate(
    predicate: ConvergencePredicate | undefined,
    input: { sessionId: string; runIndex: number },
  ): boolean {
    if (!predicate) return false;

    switch (predicate.kind) {
      case "truth_resolved": {
        const truth = this.runtimePort.getTruthState(input.sessionId);
        return truth.facts.some(
          (fact) => fact.id === predicate.factId && fact.status === "resolved",
        );
      }
      case "task_phase": {
        const task = this.runtimePort.getTaskState(input.sessionId);
        return task.status?.phase === predicate.phase;
      }
      case "max_runs":
        return input.runIndex >= predicate.limit;
      case "all_of":
        return predicate.predicates.every((item) => this.evaluateConvergencePredicate(item, input));
      case "any_of":
        return predicate.predicates.some((item) => this.evaluateConvergencePredicate(item, input));
      default:
        return false;
    }
  }

  private async fireIntent(intentId: string): Promise<void> {
    if (!this.enableExecution) return;
    if (this.fireInProgress.has(intentId)) return;
    const intent = this.intentsById.get(intentId);
    if (!intent || intent.status !== "active") return;

    const now = this.now();
    if (intent.leaseUntilMs !== undefined && intent.leaseUntilMs > now) {
      this.armTimer(intent);
      return;
    }

    this.fireInProgress.add(intentId);
    try {
      intent.leaseUntilMs = addMilliseconds(
        now,
        this.runtimePort.scheduleConfig.leaseDurationMs,
      ).getTime();
      this.persistProjection(now);

      const runIndex = intent.runCount + 1;
      let executionErrorText: string | undefined;
      let executionResult: ScheduleIntentExecutionResult | undefined;

      try {
        executionResult = (await this.executeIntent(intent)) ?? undefined;
      } catch (error) {
        executionErrorText = error instanceof Error ? error.message : String(error);
      }

      const evaluationSessionId =
        typeof executionResult?.evaluationSessionId === "string" &&
        executionResult.evaluationSessionId.trim().length > 0
          ? executionResult.evaluationSessionId
          : intent.parentSessionId;
      const convergedByPredicate = !executionErrorText
        ? this.evaluateConvergencePredicate(intent.convergenceCondition, {
            sessionId: evaluationSessionId,
            runIndex,
          })
        : false;
      const convergedByMaxRuns = !executionErrorText && runIndex >= intent.maxRuns;

      let nextRunAt: number | undefined;
      let schedulingErrorText: string | undefined;
      if (executionErrorText) {
        const consecutiveErrors = intent.consecutiveErrors + 1;
        if (consecutiveErrors >= this.runtimePort.scheduleConfig.maxConsecutiveErrors) {
          nextRunAt = undefined;
        } else {
          nextRunAt = addMilliseconds(now, this.computeRetryBackoffMs(consecutiveErrors)).getTime();
        }
      } else if (convergedByPredicate || convergedByMaxRuns) {
        nextRunAt = undefined;
      } else if (intent.cron) {
        nextRunAt = this.computeCronNextRunAt(
          intent.cron,
          subMilliseconds(
            addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs),
            1,
          ).getTime(),
          intent.timeZone,
        );
        if (nextRunAt === undefined) {
          schedulingErrorText = "cron_has_no_future_match";
        }
      } else {
        nextRunAt =
          this.normalizeExecutionNextRunAt(executionResult?.nextRunAt, now) ??
          addMilliseconds(now, this.runtimePort.scheduleConfig.minIntervalMs).getTime();
      }
      const errorText = executionErrorText ?? schedulingErrorText;

      const firedPayload = buildScheduleIntentFiredEvent({
        intentId: intent.intentId,
        parentSessionId: intent.parentSessionId,
        reason: intent.reason,
        goalRef: intent.goalRef,
        continuityMode: intent.continuityMode,
        runAt: intent.runAt,
        cron: intent.cron,
        timeZone: intent.timeZone,
        maxRuns: intent.maxRuns,
        convergenceCondition: intent.convergenceCondition,
        runIndex,
        firedAt: now,
        nextRunAt,
        childSessionId: executionResult?.evaluationSessionId,
        error: errorText,
      });
      this.appendScheduleEvent(firedPayload);

      if (errorText && nextRunAt === undefined) {
        const cancelledPayload = buildScheduleIntentCancelledEvent({
          intentId: intent.intentId,
          parentSessionId: intent.parentSessionId,
          reason: intent.reason,
          goalRef: intent.goalRef,
          continuityMode: intent.continuityMode,
          runAt: intent.runAt,
          cron: intent.cron,
          timeZone: intent.timeZone,
          maxRuns: intent.maxRuns,
          convergenceCondition: intent.convergenceCondition,
          error: executionErrorText ? `circuit_open:${executionErrorText}` : errorText,
        });
        this.appendScheduleEvent(cancelledPayload);
      } else if (!errorText && (convergedByPredicate || convergedByMaxRuns)) {
        const convergedPayload = buildScheduleIntentConvergedEvent({
          intentId: intent.intentId,
          parentSessionId: intent.parentSessionId,
          reason: intent.reason,
          goalRef: intent.goalRef,
          continuityMode: intent.continuityMode,
          runAt: intent.runAt,
          cron: intent.cron,
          timeZone: intent.timeZone,
          maxRuns: intent.maxRuns,
          convergenceCondition: intent.convergenceCondition,
        });
        this.appendScheduleEvent(convergedPayload);
      }

      const updated = this.intentsById.get(intentId);
      if (updated) this.armTimer(updated);
    } finally {
      this.fireInProgress.delete(intentId);
    }
  }
}
