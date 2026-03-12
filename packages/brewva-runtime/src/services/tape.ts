import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
  coerceTapeAnchorPayload,
  type TapeCheckpointEvidenceState,
  type TapeCheckpointProjectionState,
} from "../tape/events.js";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  OutputSearchTelemetryState,
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
const OUTPUT_SEARCH_EVENT_TYPE = "tool_output_search";
const OUTPUT_SEARCH_EVENT_LOOKBACK = 120;

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
  getCheckpointProjectionState: RuntimeCallback<[sessionId: string], TapeCheckpointProjectionState>;
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
  private readonly getCheckpointProjectionState: (
    sessionId: string,
  ) => TapeCheckpointProjectionState;
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
    this.getCheckpointProjectionState = options.getCheckpointProjectionState;
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

  private toNonNegativeCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }

  private toSearchThrottleLevel(value: unknown): OutputSearchTelemetryState["lastThrottleLevel"] {
    if (value === "normal" || value === "limited" || value === "blocked") return value;
    return "unknown";
  }

  private buildOutputSearchTelemetry(sessionId: string): OutputSearchTelemetryState | undefined {
    const events = this.queryEvents(sessionId, {
      type: OUTPUT_SEARCH_EVENT_TYPE,
      last: OUTPUT_SEARCH_EVENT_LOOKBACK,
    });
    if (events.length === 0) return undefined;

    const telemetry: OutputSearchTelemetryState = {
      recentCalls: 0,
      singleQueryCalls: 0,
      batchedCalls: 0,
      throttledCalls: 0,
      blockedCalls: 0,
      totalQueries: 0,
      totalResults: 0,
      averageResultsPerQuery: null,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: null,
      matchLayers: {
        exact: 0,
        partial: 0,
        fuzzy: 0,
        none: 0,
      },
      lastThrottleLevel: "unknown",
      lastTimestamp: undefined,
    };

    let latestTimestamp = 0;
    for (const event of events) {
      telemetry.recentCalls += 1;
      const payload = event.payload ?? {};
      const queryCount = this.toNonNegativeCount(payload.queryCount);
      const resultCount = this.toNonNegativeCount(payload.resultCount);
      const cacheHits = this.toNonNegativeCount(payload.cacheHits);
      const cacheMisses = this.toNonNegativeCount(payload.cacheMisses);
      const throttleLevel = this.toSearchThrottleLevel(payload.throttleLevel);

      telemetry.totalQueries += queryCount;
      telemetry.totalResults += resultCount;
      telemetry.cacheHits += cacheHits;
      telemetry.cacheMisses += cacheMisses;

      if (queryCount === 1) telemetry.singleQueryCalls += 1;
      if (queryCount > 1) telemetry.batchedCalls += 1;
      if (throttleLevel === "limited" || throttleLevel === "blocked") {
        telemetry.throttledCalls += 1;
      }

      const blocked = payload.blocked === true || throttleLevel === "blocked";
      if (blocked) telemetry.blockedCalls += 1;

      if (event.timestamp >= latestTimestamp) {
        latestTimestamp = event.timestamp;
        telemetry.lastTimestamp = event.timestamp;
        telemetry.lastThrottleLevel = throttleLevel;
      }

      const matchLayersPayload = payload.matchLayers;
      if (matchLayersPayload && typeof matchLayersPayload === "object") {
        for (const layer of Object.values(matchLayersPayload)) {
          if (layer === "exact" || layer === "partial" || layer === "fuzzy" || layer === "none") {
            telemetry.matchLayers[layer] += 1;
          }
        }
      }
    }

    telemetry.averageResultsPerQuery =
      telemetry.totalQueries > 0 ? telemetry.totalResults / telemetry.totalQueries : null;
    const totalCacheLoads = telemetry.cacheHits + telemetry.cacheMisses;
    telemetry.cacheHitRate = totalCacheLoads > 0 ? telemetry.cacheHits / totalCacheLoads : null;

    return telemetry;
  }

  getTapeStatus(sessionId: string): TapeStatusState {
    const state = this.sessionState.getCell(sessionId);
    const events = this.queryEvents(sessionId);
    const totalEntries = events.length;

    const counterInitialized = state.tapeCheckpointCounterInitialized;

    let lastAnchorIndex = -1;
    let lastCheckpointIndex = -1;
    let lastAnchorEvent: BrewvaEventRecord | undefined;
    let lastCheckpointId: string | undefined;

    if (counterInitialized) {
      lastCheckpointId = state.tapeLastCheckpointEventId;
      const targetAnchorId = state.tapeLatestAnchorEventId;
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
      ? state.tapeEntriesSinceCheckpoint
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
      outputSearch: this.buildOutputSearchTelemetry(sessionId),
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
    const cell = this.sessionState.getCell(sessionId);
    cell.tapeCheckpointCounterInitialized = true;
    cell.tapeEntriesSinceCheckpoint = Math.max(0, Math.floor(state.entriesSinceCheckpoint));
    cell.tapeLatestAnchorEventId = state.latestAnchorEventId;
    cell.tapeLastCheckpointEventId = state.lastCheckpointEventId;
    cell.tapeProcessedEventIdsSinceCheckpoint = state.processedEventIds;
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
      if (event.type.startsWith("projection_")) {
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
    const cell = this.sessionState.getCell(sessionId);
    if (!cell.tapeCheckpointCounterInitialized) {
      return this.bootstrapTapeCheckpointCounter(sessionId);
    }
    return {
      entriesSinceCheckpoint: cell.tapeEntriesSinceCheckpoint,
      latestAnchorEventId: cell.tapeLatestAnchorEventId,
      lastCheckpointEventId: cell.tapeLastCheckpointEventId,
      processedEventIds: cell.tapeProcessedEventIdsSinceCheckpoint,
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
    if (event.type.startsWith("projection_")) {
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
    const cell = this.sessionState.getCell(sessionId);
    if (cell.tapeCheckpointWriteInProgress) {
      return;
    }

    const counterState = this.getTapeCheckpointCounter(sessionId);
    this.applyEventToTapeCheckpointCounter(counterState, lastEvent);
    this.writeTapeCheckpointCounter(sessionId, counterState);

    if (lastEvent.type === TAPE_CHECKPOINT_EVENT_TYPE || lastEvent.type.startsWith("projection_")) {
      return;
    }

    if (counterState.entriesSinceCheckpoint < intervalEntries) {
      return;
    }

    cell.tapeCheckpointWriteInProgress = true;
    try {
      const payload = buildTapeCheckpointPayload({
        taskState: this.getTaskState(sessionId),
        truthState: this.getTruthState(sessionId),
        costSummary: this.getCostSummary(sessionId),
        costSkillLastTurnByName: this.getCostSkillLastTurnByName(sessionId),
        evidenceState: this.getCheckpointEvidenceState(sessionId),
        projectionState: this.getCheckpointProjectionState(sessionId),
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
      cell.tapeCheckpointWriteInProgress = false;
    }
  }
}
