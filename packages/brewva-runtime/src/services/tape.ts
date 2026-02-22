import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
  coerceTapeAnchorPayload,
} from "../tape/events.js";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  TapePressureLevel,
  TapeSearchMatch,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  TaskState,
  TruthState,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface TapeServiceOptions {
  tapeConfig: BrewvaConfig["tape"];
  sessionState: RuntimeSessionStateStore;
  queryEvents: RuntimeCallback<[sessionId: string, query?: BrewvaEventQuery], BrewvaEventRecord[]>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

export class TapeService {
  private readonly tapeConfig: BrewvaConfig["tape"];
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly queryEvents: (
    sessionId: string,
    query?: BrewvaEventQuery,
  ) => BrewvaEventRecord[];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly recordEvent: TapeServiceOptions["recordEvent"];

  constructor(options: TapeServiceOptions) {
    this.tapeConfig = options.tapeConfig;
    this.sessionState = options.sessionState;
    this.queryEvents = options.queryEvents;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.recordEvent = options.recordEvent;
  }

  private resolveTapePressureLevel(entriesSinceAnchor: number): TapePressureLevel {
    const thresholds = this.tapeConfig.tapePressureThresholds;
    if (entriesSinceAnchor >= thresholds.high) return "high";
    if (entriesSinceAnchor >= thresholds.medium) return "medium";
    if (entriesSinceAnchor >= thresholds.low) return "low";
    return "none";
  }

  getTapeStatus(sessionId: string): TapeStatusState {
    const events = this.queryEvents(sessionId);
    const totalEntries = events.length;

    let lastAnchorIndex = -1;
    let lastCheckpointIndex = -1;
    let lastAnchorEvent: BrewvaEventRecord | undefined;
    let lastCheckpointId: string | undefined;

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;

      if (lastCheckpointIndex < 0 && event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
        lastCheckpointIndex = index;
        lastCheckpointId = event.id;
      }

      if (lastAnchorIndex < 0 && event.type === TAPE_ANCHOR_EVENT_TYPE) {
        lastAnchorIndex = index;
        lastAnchorEvent = event;
      }

      if (lastAnchorIndex >= 0 && lastCheckpointIndex >= 0) {
        break;
      }
    }

    const entriesSinceAnchor =
      lastAnchorIndex >= 0 ? Math.max(0, totalEntries - lastAnchorIndex - 1) : totalEntries;
    const entriesSinceCheckpoint =
      lastCheckpointIndex >= 0 ? Math.max(0, totalEntries - lastCheckpointIndex - 1) : totalEntries;

    const thresholds = this.tapeConfig.tapePressureThresholds;
    const anchorPayload = coerceTapeAnchorPayload(lastAnchorEvent?.payload);

    return {
      totalEntries,
      entriesSinceAnchor,
      entriesSinceCheckpoint,
      tapePressure: this.resolveTapePressureLevel(entriesSinceAnchor),
      thresholds: {
        low: thresholds.low,
        medium: thresholds.medium,
        high: thresholds.high,
      },
      lastAnchor: lastAnchorEvent
        ? {
            id: lastAnchorEvent.id,
            name: anchorPayload?.name,
            summary: anchorPayload?.summary,
            nextSteps: anchorPayload?.nextSteps,
            turn: lastAnchorEvent.turn,
            timestamp: lastAnchorEvent.timestamp,
          }
        : undefined,
      lastCheckpointId,
    };
  }

  recordTapeHandoff(
    sessionId: string,
    input: { name: string; summary?: string; nextSteps?: string },
  ): {
    ok: boolean;
    eventId?: string;
    createdAt?: number;
    error?: string;
    tapeStatus?: TapeStatusState;
  } {
    const name = input.name?.trim();
    if (!name) {
      return { ok: false, error: "missing_name" };
    }

    const summary = input.summary?.trim() || undefined;
    const nextSteps = input.nextSteps?.trim() || undefined;
    const payload = buildTapeAnchorPayload({
      name,
      summary,
      nextSteps,
    });

    const row = this.recordEvent({
      sessionId,
      type: TAPE_ANCHOR_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: payload as unknown as Record<string, unknown>,
    });
    if (!row) {
      return { ok: false, error: "event_store_disabled" };
    }

    return {
      ok: true,
      eventId: row.id,
      createdAt: payload.createdAt,
      tapeStatus: this.getTapeStatus(sessionId),
    };
  }

  private buildTapeSearchText(event: BrewvaEventRecord): string {
    if (event.type === TAPE_ANCHOR_EVENT_TYPE) {
      const payload = coerceTapeAnchorPayload(event.payload);
      if (!payload) return `anchor ${event.id}`;
      return ["anchor", payload.name, payload.summary ?? "", payload.nextSteps ?? ""]
        .join(" ")
        .trim();
    }
    const payloadText =
      event.payload && Object.keys(event.payload).length > 0 ? JSON.stringify(event.payload) : "";
    return `${event.type} ${payloadText}`.trim();
  }

  private trimSearchExcerpt(text: string, maxChars = 220): string {
    const compact = text.replaceAll(/\s+/g, " ").trim();
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
  }

  private scopeTapeEvents(
    events: BrewvaEventRecord[],
    scope: TapeSearchScope,
  ): BrewvaEventRecord[] {
    if (scope === "anchors_only") {
      return events.filter((event) => event.type === TAPE_ANCHOR_EVENT_TYPE);
    }
    if (scope === "all_phases") {
      return events;
    }

    let lastAnchorIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type !== TAPE_ANCHOR_EVENT_TYPE) continue;
      lastAnchorIndex = index;
      break;
    }
    if (lastAnchorIndex < 0) return events;
    return events.slice(lastAnchorIndex);
  }

  searchTape(
    sessionId: string,
    input: { query: string; scope?: TapeSearchScope; limit?: number },
  ): TapeSearchResult {
    const query = input.query.trim();
    const scope: TapeSearchScope = input.scope ?? "current_phase";
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 12)));
    const events = this.queryEvents(sessionId);
    const scopedEvents = this.scopeTapeEvents(events, scope);

    if (!query) {
      return {
        query,
        scope,
        scannedEvents: scopedEvents.length,
        totalEvents: events.length,
        matches: [],
      };
    }

    const needle = query.toLowerCase();
    const matches: TapeSearchMatch[] = [];

    for (let index = scopedEvents.length - 1; index >= 0; index -= 1) {
      if (matches.length >= limit) break;
      const event = scopedEvents[index];
      if (!event) continue;

      const haystack = this.buildTapeSearchText(event);
      if (!haystack.toLowerCase().includes(needle)) continue;

      matches.push({
        eventId: event.id,
        type: event.type,
        turn: event.turn,
        timestamp: event.timestamp,
        excerpt: this.trimSearchExcerpt(haystack),
      });
    }

    return {
      query,
      scope,
      scannedEvents: scopedEvents.length,
      totalEvents: events.length,
      matches,
    };
  }

  private resolveTapeCheckpointIntervalEntries(): number {
    const configured = this.tapeConfig.checkpointIntervalEntries;
    if (!Number.isFinite(configured)) return 0;
    return Math.max(0, Math.floor(configured));
  }

  maybeRecordTapeCheckpoint(lastEvent: BrewvaEventRecord): void {
    if (lastEvent.type === TAPE_CHECKPOINT_EVENT_TYPE) {
      return;
    }
    if (lastEvent.type.startsWith("memory_")) {
      return;
    }

    const intervalEntries = this.resolveTapeCheckpointIntervalEntries();
    if (intervalEntries <= 0) {
      return;
    }

    const sessionId = lastEvent.sessionId;
    if (this.sessionState.tapeCheckpointWriteInProgressBySession.has(sessionId)) {
      return;
    }

    const events = this.queryEvents(sessionId);
    if (events.length === 0) {
      return;
    }

    let latestAnchorEventId: string | undefined;
    let entriesSinceCheckpoint = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (!latestAnchorEventId && event.type === TAPE_ANCHOR_EVENT_TYPE) {
        latestAnchorEventId = event.id;
      }
      if (event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
        break;
      }
      if (event.type.startsWith("memory_")) {
        continue;
      }
      entriesSinceCheckpoint += 1;
    }

    if (entriesSinceCheckpoint < intervalEntries) {
      return;
    }

    this.sessionState.tapeCheckpointWriteInProgressBySession.add(sessionId);
    try {
      const payload = buildTapeCheckpointPayload({
        taskState: this.getTaskState(sessionId),
        truthState: this.getTruthState(sessionId),
        basedOnEventId: lastEvent.id,
        latestAnchorEventId,
        reason: `interval_entries_${intervalEntries}`,
      });
      this.recordEvent({
        sessionId,
        turn: this.getCurrentTurn(sessionId),
        type: TAPE_CHECKPOINT_EVENT_TYPE,
        payload: payload as unknown as Record<string, unknown>,
        skipTapeCheckpoint: true,
      });
    } finally {
      this.sessionState.tapeCheckpointWriteInProgressBySession.delete(sessionId);
    }
  }
}
