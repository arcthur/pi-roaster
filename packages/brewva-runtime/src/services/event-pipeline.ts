import { formatISO } from "date-fns";
import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  SKILL_CASCADE_ABORTED_EVENT_TYPE,
  SKILL_CASCADE_FINISHED_EVENT_TYPE,
  SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE,
  SKILL_CASCADE_PAUSED_EVENT_TYPE,
  SKILL_CASCADE_PLANNED_EVENT_TYPE,
  SKILL_CASCADE_REPLANNED_EVENT_TYPE,
  SKILL_CASCADE_STEP_COMPLETED_EVENT_TYPE,
  SKILL_CASCADE_STEP_STARTED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../events/event-types.js";
import { BrewvaEventStore } from "../events/store.js";
import { SCHEDULE_EVENT_TYPE } from "../schedule/events.js";
import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "../tape/events.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import { TRUTH_EVENT_TYPE } from "../truth/ledger.js";
import type {
  BrewvaEventCategory,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";

const AUDIT_EVENT_TYPES = new Set<string>([
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  "governance_verify_spec_passed",
  "governance_verify_spec_failed",
  "governance_verify_spec_error",
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SKILL_CASCADE_PLANNED_EVENT_TYPE,
  SKILL_CASCADE_STEP_STARTED_EVENT_TYPE,
  SKILL_CASCADE_STEP_COMPLETED_EVENT_TYPE,
  SKILL_CASCADE_PAUSED_EVENT_TYPE,
  SKILL_CASCADE_REPLANNED_EVENT_TYPE,
  SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE,
  SKILL_CASCADE_FINISHED_EVENT_TYPE,
  SKILL_CASCADE_ABORTED_EVENT_TYPE,
]);

const DEBUG_EVENT_TYPES = new Set<string>(["tool_parallel_read"]);

const TURN_WAL_EVENT_TYPES = new Set<string>([
  "turn_wal_appended",
  "turn_wal_status_changed",
  "turn_wal_recovery_completed",
  "turn_wal_compacted",
]);
const EVENT_LISTENER_ERROR_EVENT_TYPE = "event_listener_error";

export interface RuntimeRecordEventInput {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
}

export interface EventPipelineServiceOptions {
  events: BrewvaEventStore;
  level: "audit" | "ops" | "debug";
  inferEventCategory: RuntimeCallback<[type: string], BrewvaEventCategory>;
  observeReplayEvent: RuntimeCallback<[event: BrewvaEventRecord]>;
  ingestProjectionEvent: RuntimeCallback<[event: BrewvaEventRecord]>;
  maybeRecordTapeCheckpoint: RuntimeCallback<[event: BrewvaEventRecord]>;
}

export class EventPipelineService {
  private readonly events: BrewvaEventStore;
  private readonly level: "audit" | "ops" | "debug";
  private readonly inferEventCategory: (type: string) => BrewvaEventCategory;
  private readonly observeReplayEvent: (event: BrewvaEventRecord) => void;
  private readonly ingestProjectionEvent: (event: BrewvaEventRecord) => void;
  private readonly maybeRecordTapeCheckpoint: (event: BrewvaEventRecord) => void;
  private readonly eventListeners = new Set<(event: BrewvaStructuredEvent) => void>();

  constructor(options: EventPipelineServiceOptions) {
    this.events = options.events;
    this.level = options.level;
    this.inferEventCategory = options.inferEventCategory;
    this.observeReplayEvent = options.observeReplayEvent;
    this.ingestProjectionEvent = options.ingestProjectionEvent;
    this.maybeRecordTapeCheckpoint = options.maybeRecordTapeCheckpoint;
  }

  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined {
    return this.appendEvent(input, { emitListeners: true });
  }

  private appendEvent(
    input: RuntimeRecordEventInput,
    options: { emitListeners: boolean },
  ): BrewvaEventRecord | undefined {
    if (!this.shouldEmit(input.type)) {
      return undefined;
    }

    const row = this.events.append({
      sessionId: input.sessionId,
      type: input.type,
      turn: input.turn,
      payload: input.payload,
      timestamp: input.timestamp,
    });
    if (!row) return undefined;

    this.observeReplayEvent(row);

    let listenerErrors:
      | Array<{
          listenerIndex: number;
          listenerName: string;
          errorName: string;
          errorMessage: string;
          errorStack?: string;
        }>
      | undefined;
    if (options.emitListeners) {
      const structured = this.toStructuredEvent(row);
      listenerErrors = this.notifyListeners(structured);
    }

    this.ingestProjectionEvent(row);
    if (!input.skipTapeCheckpoint) {
      this.maybeRecordTapeCheckpoint(row);
    }

    if (listenerErrors && listenerErrors.length > 0) {
      for (const listenerError of listenerErrors) {
        this.appendEvent(
          {
            sessionId: row.sessionId,
            type: EVENT_LISTENER_ERROR_EVENT_TYPE,
            turn: row.turn,
            timestamp: row.timestamp,
            payload: {
              sourceEventId: row.id,
              sourceEventType: row.type,
              listenerIndex: listenerError.listenerIndex,
              listenerName: listenerError.listenerName,
              errorName: listenerError.errorName,
              errorMessage: listenerError.errorMessage,
              errorStack: listenerError.errorStack,
            },
            skipTapeCheckpoint: true,
          },
          { emitListeners: false },
        );
      }
    }

    return row;
  }

  private shouldEmit(type: string): boolean {
    if (this.level === "debug") return true;
    const eventLevel = this.classifyEventLevel(type);
    if (this.level === "ops") return eventLevel !== "debug";
    return eventLevel === "audit";
  }

  private classifyEventLevel(type: string): "audit" | "ops" | "debug" {
    if (AUDIT_EVENT_TYPES.has(type)) return "audit";
    if (type === EVENT_LISTENER_ERROR_EVENT_TYPE) return "audit";
    if (DEBUG_EVENT_TYPES.has(type)) return "debug";
    if (TURN_WAL_EVENT_TYPES.has(type)) return "ops";
    if (type.startsWith("governance_")) return "ops";
    return "ops";
  }

  queryEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaEventRecord[] {
    return this.events.list(sessionId, query);
  }

  queryStructuredEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaStructuredEvent[] {
    return this.events.list(sessionId, query).map((event) => this.toStructuredEvent(event));
  }

  listReplaySessions(limit = 20): BrewvaReplaySession[] {
    const sessionIds = this.events.listSessionIds();
    const rows: BrewvaReplaySession[] = [];

    for (const sessionId of sessionIds) {
      const events = this.events.list(sessionId);
      if (events.length === 0) continue;
      const lastEventAt = events[events.length - 1]?.timestamp ?? 0;
      rows.push({
        sessionId,
        eventCount: events.length,
        lastEventAt,
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private notifyListeners(event: BrewvaStructuredEvent): Array<{
    listenerIndex: number;
    listenerName: string;
    errorName: string;
    errorMessage: string;
    errorStack?: string;
  }> {
    const errors: Array<{
      listenerIndex: number;
      listenerName: string;
      errorName: string;
      errorMessage: string;
      errorStack?: string;
    }> = [];
    let listenerIndex = 0;
    for (const listener of this.eventListeners.values()) {
      listenerIndex += 1;
      try {
        listener(event);
      } catch (error) {
        errors.push({
          listenerIndex,
          listenerName: listener.name || "anonymous_listener",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
    return errors;
  }

  toStructuredEvent(event: BrewvaEventRecord): BrewvaStructuredEvent {
    return {
      schema: "brewva.event.v1",
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      category: this.inferEventCategory(event.type),
      timestamp: event.timestamp,
      isoTime: formatISO(event.timestamp),
      turn: event.turn,
      payload: event.payload,
    };
  }
}
