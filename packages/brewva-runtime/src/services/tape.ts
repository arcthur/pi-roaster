import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
  coerceTapeAnchorPayload,
  type TapeCheckpointEvidenceState,
  type TapeCheckpointMemoryState,
} from "../tape/events.js";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  SessionCostSummary,
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

const TAPE_PRESSURE_THRESHOLDS = {
  low: 80,
  medium: 160,
  high: 280,
} as const;

export interface TapeServiceOptions {
  tapeConfig: BrewvaConfig["tape"];
  sessionState: RuntimeSessionStateStore;
  queryEvents: RuntimeCallback<[sessionId: string, query?: BrewvaEventQuery], BrewvaEventRecord[]>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  getCostSummary: RuntimeCallback<[sessionId: string], SessionCostSummary>;
  getCostSkillLastTurnByName: RuntimeCallback<[sessionId: string], Record<string, number>>;
  getCheckpointEvidenceState: RuntimeCallback<[sessionId: string], TapeCheckpointEvidenceState>;
  getCheckpointMemoryState: RuntimeCallback<[sessionId: string], TapeCheckpointMemoryState>;
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

interface TapeCheckpointCounterState {
  entriesSinceCheckpoint: number;
  latestAnchorEventId?: string;
  lastCheckpointEventId?: string;
  processedEventIds: Set<string>;
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
  private readonly getCostSummary: (sessionId: string) => SessionCostSummary;
  private readonly getCostSkillLastTurnByName: (sessionId: string) => Record<string, number>;
  private readonly getCheckpointEvidenceState: (sessionId: string) => TapeCheckpointEvidenceState;
  private readonly getCheckpointMemoryState: (sessionId: string) => TapeCheckpointMemoryState;
  private readonly recordEvent: TapeServiceOptions["recordEvent"];

  constructor(options: TapeServiceOptions) {
    this.tapeConfig = options.tapeConfig;
    this.sessionState = options.sessionState;
    this.queryEvents = options.queryEvents;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.getCostSummary = options.getCostSummary;
    this.getCostSkillLastTurnByName = options.getCostSkillLastTurnByName;
    this.getCheckpointEvidenceState = options.getCheckpointEvidenceState;
    this.getCheckpointMemoryState = options.getCheckpointMemoryState;
    this.recordEvent = options.recordEvent;
  }

  private resolveTapePressureLevel(entriesSinceAnchor: number): TapePressureLevel {
    const thresholds = TAPE_PRESSURE_THRESHOLDS;
    if (entriesSinceAnchor >= thresholds.high) return "high";
    if (entriesSinceAnchor >= thresholds.medium) return "medium";
    if (entriesSinceAnchor >= thresholds.low) return "low";
    return "none";
  }

  getPressureThresholds(): TapeStatusState["thresholds"] {
    return { ...TAPE_PRESSURE_THRESHOLDS };
  }

  getTapeStatus(sessionId: string): TapeStatusState {
    const events = this.queryEvents(sessionId);
    const totalEntries = events.length;

    const counterInitialized =
      this.sessionState.tapeCheckpointCounterInitializedBySession.has(sessionId);

    let lastAnchorIndex = -1;
    let lastCheckpointIndex = -1;
    let lastAnchorEvent: BrewvaEventRecord | undefined;
    let lastCheckpointId: string | undefined;

    if (counterInitialized) {
      lastCheckpointId = this.sessionState.tapeLastCheckpointEventIdBySession.get(sessionId);
      const targetAnchorId = this.sessionState.tapeLatestAnchorEventIdBySession.get(sessionId);
      if (targetAnchorId) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (!event) continue;
          if (event.id === targetAnchorId) {
            lastAnchorIndex = index;
            lastAnchorEvent = event;
            break;
          }
        }
      }
    } else {
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
    }

    const entriesSinceAnchor =
      lastAnchorIndex >= 0 ? Math.max(0, totalEntries - lastAnchorIndex - 1) : totalEntries;
    const entriesSinceCheckpoint = counterInitialized
      ? (this.sessionState.tapeEntriesSinceCheckpointBySession.get(sessionId) ?? totalEntries)
      : lastCheckpointIndex >= 0
        ? Math.max(0, totalEntries - lastCheckpointIndex - 1)
        : totalEntries;

    const thresholds = this.getPressureThresholds();
    const anchorPayload = coerceTapeAnchorPayload(lastAnchorEvent?.payload);

    return {
      totalEntries,
      entriesSinceAnchor,
      entriesSinceCheckpoint,
      tapePressure: this.resolveTapePressureLevel(entriesSinceAnchor),
      thresholds,
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

  private writeTapeCheckpointCounter(sessionId: string, state: TapeCheckpointCounterState): void {
    this.sessionState.tapeCheckpointCounterInitializedBySession.add(sessionId);
    this.sessionState.tapeEntriesSinceCheckpointBySession.set(
      sessionId,
      Math.max(0, Math.floor(state.entriesSinceCheckpoint)),
    );
    if (state.latestAnchorEventId) {
      this.sessionState.tapeLatestAnchorEventIdBySession.set(sessionId, state.latestAnchorEventId);
    } else {
      this.sessionState.tapeLatestAnchorEventIdBySession.delete(sessionId);
    }
    if (state.lastCheckpointEventId) {
      this.sessionState.tapeLastCheckpointEventIdBySession.set(
        sessionId,
        state.lastCheckpointEventId,
      );
    } else {
      this.sessionState.tapeLastCheckpointEventIdBySession.delete(sessionId);
    }
    this.sessionState.tapeProcessedEventIdsSinceCheckpointBySession.set(
      sessionId,
      state.processedEventIds,
    );
  }

  private bootstrapTapeCheckpointCounter(sessionId: string): TapeCheckpointCounterState {
    const events = this.queryEvents(sessionId);
    let latestAnchorEventId: string | undefined;
    let lastCheckpointEventId: string | undefined;
    let entriesSinceCheckpoint = 0;
    const processedEventIds = new Set<string>();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (!latestAnchorEventId && event.type === TAPE_ANCHOR_EVENT_TYPE) {
        latestAnchorEventId = event.id;
      }
      if (event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
        lastCheckpointEventId = event.id;
        break;
      }
      processedEventIds.add(event.id);
      if (event.type.startsWith("memory_")) {
        continue;
      }
      entriesSinceCheckpoint += 1;
    }

    const state: TapeCheckpointCounterState = {
      entriesSinceCheckpoint,
      latestAnchorEventId,
      lastCheckpointEventId,
      processedEventIds,
    };
    this.writeTapeCheckpointCounter(sessionId, state);
    return state;
  }

  private getTapeCheckpointCounter(sessionId: string): TapeCheckpointCounterState {
    if (!this.sessionState.tapeCheckpointCounterInitializedBySession.has(sessionId)) {
      return this.bootstrapTapeCheckpointCounter(sessionId);
    }
    return {
      entriesSinceCheckpoint:
        this.sessionState.tapeEntriesSinceCheckpointBySession.get(sessionId) ?? 0,
      latestAnchorEventId: this.sessionState.tapeLatestAnchorEventIdBySession.get(sessionId),
      lastCheckpointEventId: this.sessionState.tapeLastCheckpointEventIdBySession.get(sessionId),
      processedEventIds:
        this.sessionState.tapeProcessedEventIdsSinceCheckpointBySession.get(sessionId) ?? new Set(),
    };
  }

  private applyEventToTapeCheckpointCounter(
    state: TapeCheckpointCounterState,
    event: BrewvaEventRecord,
  ): void {
    if (state.processedEventIds.has(event.id)) {
      return;
    }
    if (event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
      state.entriesSinceCheckpoint = 0;
      state.lastCheckpointEventId = event.id;
      state.processedEventIds = new Set<string>([event.id]);
      return;
    }
    state.processedEventIds.add(event.id);
    if (event.type === TAPE_ANCHOR_EVENT_TYPE) {
      state.latestAnchorEventId = event.id;
    }
    if (event.type.startsWith("memory_")) {
      return;
    }
    state.entriesSinceCheckpoint += 1;
  }

  maybeRecordTapeCheckpoint(lastEvent: BrewvaEventRecord): void {
    const intervalEntries = this.resolveTapeCheckpointIntervalEntries();
    if (intervalEntries <= 0) {
      return;
    }

    const sessionId = lastEvent.sessionId;
    if (this.sessionState.tapeCheckpointWriteInProgressBySession.has(sessionId)) {
      return;
    }

    const counterState = this.getTapeCheckpointCounter(sessionId);
    this.applyEventToTapeCheckpointCounter(counterState, lastEvent);
    this.writeTapeCheckpointCounter(sessionId, counterState);

    if (lastEvent.type === TAPE_CHECKPOINT_EVENT_TYPE || lastEvent.type.startsWith("memory_")) {
      return;
    }

    if (counterState.entriesSinceCheckpoint < intervalEntries) {
      return;
    }

    this.sessionState.tapeCheckpointWriteInProgressBySession.add(sessionId);
    try {
      const payload = buildTapeCheckpointPayload({
        taskState: this.getTaskState(sessionId),
        truthState: this.getTruthState(sessionId),
        costSummary: this.getCostSummary(sessionId),
        costSkillLastTurnByName: this.getCostSkillLastTurnByName(sessionId),
        evidenceState: this.getCheckpointEvidenceState(sessionId),
        memoryState: this.getCheckpointMemoryState(sessionId),
        basedOnEventId: lastEvent.id,
        latestAnchorEventId: counterState.latestAnchorEventId,
        reason: `interval_entries_${intervalEntries}`,
      });
      const row = this.recordEvent({
        sessionId,
        turn: this.getCurrentTurn(sessionId),
        type: TAPE_CHECKPOINT_EVENT_TYPE,
        payload: payload as unknown as Record<string, unknown>,
        skipTapeCheckpoint: true,
      });
      if (row) {
        counterState.entriesSinceCheckpoint = 0;
        counterState.lastCheckpointEventId = row.id;
        counterState.processedEventIds = new Set<string>([row.id]);
        this.writeTapeCheckpointCounter(sessionId, counterState);
      }
    } finally {
      this.sessionState.tapeCheckpointWriteInProgressBySession.delete(sessionId);
    }
  }
}
