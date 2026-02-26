import { formatISO } from "date-fns";
import { BrewvaEventStore } from "../events/store.js";
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
  "tool_result_recorded",
  "verification_outcome_recorded",
  "verification_state_reset",
  "schedule_intent",
  "schedule_recovery_deferred",
  "schedule_recovery_summary",
  "schedule_wakeup",
  "schedule_child_session_started",
  "schedule_child_session_finished",
  "schedule_child_session_failed",
  "exec_routed",
  "exec_fallback_host",
  "exec_blocked_isolation",
  "exec_sandbox_error",
]);

const DEBUG_EVENT_TYPES = new Set<string>([
  "viewport_built",
  "viewport_policy_evaluated",
  "tool_parallel_read",
  "cognitive_usage_recorded",
  "cognitive_relation_inference",
  "cognitive_relation_inference_skipped",
  "cognitive_relation_inference_failed",
  "cognitive_relevance_ranking",
  "cognitive_relevance_ranking_skipped",
  "cognitive_relevance_ranking_failed",
  "cognitive_outcome_reflection",
  "cognitive_outcome_reflection_skipped",
  "cognitive_outcome_reflection_failed",
]);

const TURN_WAL_EVENT_TYPES = new Set<string>([
  "turn_wal_appended",
  "turn_wal_status_changed",
  "turn_wal_recovery_completed",
  "turn_wal_compacted",
]);

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
  ingestMemoryEvent: RuntimeCallback<[event: BrewvaEventRecord]>;
  maybeRecordTapeCheckpoint: RuntimeCallback<[event: BrewvaEventRecord]>;
}

export class EventPipelineService {
  private readonly events: BrewvaEventStore;
  private readonly level: "audit" | "ops" | "debug";
  private readonly inferEventCategory: (type: string) => BrewvaEventCategory;
  private readonly observeReplayEvent: (event: BrewvaEventRecord) => void;
  private readonly ingestMemoryEvent: (event: BrewvaEventRecord) => void;
  private readonly maybeRecordTapeCheckpoint: (event: BrewvaEventRecord) => void;
  private readonly eventListeners = new Set<(event: BrewvaStructuredEvent) => void>();

  constructor(options: EventPipelineServiceOptions) {
    this.events = options.events;
    this.level = options.level;
    this.inferEventCategory = options.inferEventCategory;
    this.observeReplayEvent = options.observeReplayEvent;
    this.ingestMemoryEvent = options.ingestMemoryEvent;
    this.maybeRecordTapeCheckpoint = options.maybeRecordTapeCheckpoint;
  }

  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined {
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

    const structured = this.toStructuredEvent(row);
    for (const listener of this.eventListeners.values()) {
      listener(structured);
    }

    this.ingestMemoryEvent(row);
    if (!input.skipTapeCheckpoint) {
      this.maybeRecordTapeCheckpoint(row);
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
    if (DEBUG_EVENT_TYPES.has(type)) return "debug";
    if (TURN_WAL_EVENT_TYPES.has(type)) return "ops";
    if (type.startsWith("viewport_")) return "debug";
    if (type.startsWith("cognitive_")) return "debug";
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
