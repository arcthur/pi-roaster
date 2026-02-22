import { formatISO } from "date-fns";
import { BrewvaEventStore } from "../events/store.js";
import type {
  BrewvaEventCategory,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";

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
  inferEventCategory: RuntimeCallback<[type: string], BrewvaEventCategory>;
  invalidateReplay: RuntimeCallback<[sessionId: string]>;
  ingestMemoryEvent: RuntimeCallback<[event: BrewvaEventRecord]>;
  maybeRecordTapeCheckpoint: RuntimeCallback<[event: BrewvaEventRecord]>;
}

export class EventPipelineService {
  private readonly events: BrewvaEventStore;
  private readonly inferEventCategory: (type: string) => BrewvaEventCategory;
  private readonly invalidateReplay: (sessionId: string) => void;
  private readonly ingestMemoryEvent: (event: BrewvaEventRecord) => void;
  private readonly maybeRecordTapeCheckpoint: (event: BrewvaEventRecord) => void;
  private readonly eventListeners = new Set<(event: BrewvaStructuredEvent) => void>();

  constructor(options: EventPipelineServiceOptions) {
    this.events = options.events;
    this.inferEventCategory = options.inferEventCategory;
    this.invalidateReplay = options.invalidateReplay;
    this.ingestMemoryEvent = options.ingestMemoryEvent;
    this.maybeRecordTapeCheckpoint = options.maybeRecordTapeCheckpoint;
  }

  recordEvent(input: RuntimeRecordEventInput): BrewvaEventRecord | undefined {
    const row = this.events.append({
      sessionId: input.sessionId,
      type: input.type,
      turn: input.turn,
      payload: input.payload,
      timestamp: input.timestamp,
    });
    if (!row) return undefined;

    this.invalidateReplay(row.sessionId);

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
