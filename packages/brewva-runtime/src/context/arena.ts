import type { ContextArenaDegradationPolicy, ContextStrategyArm } from "../types.js";
import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import type {
  ContextInjectionEntry,
  ContextInjectionPlanResult,
  ContextInjectionPriority,
  ContextInjectionRegisterResult,
  ContextInjectionTruncationStrategy,
  RegisterContextInjectionInput,
} from "./injection.js";
import {
  ZoneBudgetController,
  type ZoneBudgetAdaptiveConfig,
  type ZoneBudgetControllerAdjustment,
  type ZoneBudgetControllerSnapshot,
  type ZoneBudgetPlanTelemetry,
} from "./zone-budget-controller.js";
import {
  ZoneBudgetAllocator,
  type ZoneBudgetAllocationResult,
  type ZoneBudgetConfig,
} from "./zone-budget.js";
import {
  createZeroZoneTokenMap,
  zoneForSource,
  zoneOrderIndex,
  type ContextZone,
} from "./zones.js";

const ENTRY_SEPARATOR = "\n\n";
const ARENA_TRIM_MIN_ENTRIES = 2_048;
const ARENA_TRIM_MIN_SUPERSEDED = 512;
const ARENA_TRIM_MIN_SUPERSEDED_RATIO = 0.25;

const PRIORITY_ORDER: Record<ContextInjectionPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const CRITICAL_ONLY_ZONES = new Set<ContextZone>(["identity", "truth", "task_state"]);

interface ArenaEntry extends ContextInjectionEntry {
  key: string;
  index: number;
  presented: boolean;
}

interface ArenaSessionState {
  entries: ArenaEntry[];
  latestIndexByKey: Map<string, number>;
  onceKeys: Set<string>;
  lastDegradationPolicy: ContextArenaDegradationPolicy | null;
}

type ZoneTokenMap = Record<ContextZone, number>;

type ZonePlanState =
  | {
      kind: "disabled";
      floorUnmet: boolean;
      appliedFloorRelaxation: ContextZone[];
      allocated: ZoneTokenMap;
    }
  | {
      kind: "floor_unmet";
      floorUnmet: true;
      appliedFloorRelaxation: ContextZone[];
      allocated: ZoneTokenMap;
    }
  | {
      kind: "ready";
      floorUnmet: boolean;
      appliedFloorRelaxation: ContextZone[];
      allocated: ZoneTokenMap;
      remaining: ZoneTokenMap;
    };

interface FloorUnmetPolicy {
  enabled: boolean;
  relaxOrder: ContextZone[];
  finalFallback: "critical_only";
}

interface ArenaCapacityDecision {
  allow: boolean;
  entriesBefore: number;
  entriesAfter: number;
  policyApplied?: ContextArenaDegradationPolicy;
  dropped: boolean;
}

export interface ArenaSnapshot {
  totalAppended: number;
  activeKeys: number;
  onceKeys: number;
  adaptiveController: ZoneBudgetControllerSnapshot | null;
}

const DEFAULT_FLOOR_UNMET_POLICY: FloorUnmetPolicy = {
  enabled: false,
  relaxOrder: ["memory_recall", "tool_failures", "memory_working"],
  finalFallback: "critical_only",
};

export class ContextArena {
  private readonly sourceTokenLimits: Record<string, number>;
  private readonly truncationStrategy: ContextInjectionTruncationStrategy;
  private readonly zoneLayout: boolean;
  private readonly baseZoneBudgets: ZoneBudgetConfig | null;
  private readonly adaptiveController: ZoneBudgetController | null;
  private readonly maxEntriesPerSession: number;
  private readonly degradationPolicy: ContextArenaDegradationPolicy;
  private readonly floorUnmetPolicy: FloorUnmetPolicy;
  private readonly sessions = new Map<string, ArenaSessionState>();

  constructor(
    options: {
      sourceTokenLimits?: Record<string, number>;
      truncationStrategy?: ContextInjectionTruncationStrategy;
      zoneLayout?: boolean;
      zoneBudgets?: ZoneBudgetConfig;
      adaptiveZones?: ZoneBudgetAdaptiveConfig;
      maxEntriesPerSession?: number;
      degradationPolicy?: ContextArenaDegradationPolicy;
      floorUnmetPolicy?: Partial<FloorUnmetPolicy>;
    } = {},
  ) {
    this.sourceTokenLimits = options.sourceTokenLimits ? { ...options.sourceTokenLimits } : {};
    this.truncationStrategy = options.truncationStrategy ?? "summarize";
    this.zoneLayout = options.zoneLayout === true;
    this.baseZoneBudgets = options.zoneBudgets ? { ...options.zoneBudgets } : null;
    this.adaptiveController =
      options.zoneBudgets && options.adaptiveZones
        ? new ZoneBudgetController(options.zoneBudgets, options.adaptiveZones)
        : null;
    this.maxEntriesPerSession = Math.max(1, Math.floor(options.maxEntriesPerSession ?? 4096));
    this.degradationPolicy = options.degradationPolicy ?? "drop_recall";
    this.floorUnmetPolicy = {
      enabled: options.floorUnmetPolicy?.enabled === true,
      relaxOrder: options.floorUnmetPolicy?.relaxOrder
        ? [...options.floorUnmetPolicy.relaxOrder]
        : [...DEFAULT_FLOOR_UNMET_POLICY.relaxOrder],
      finalFallback:
        options.floorUnmetPolicy?.finalFallback ?? DEFAULT_FLOOR_UNMET_POLICY.finalFallback,
    };
  }

  append(sessionId: string, input: RegisterContextInjectionInput): ContextInjectionRegisterResult {
    const source = input.source.trim();
    const id = input.id.trim();
    if (!sessionId || !source || !id) return { accepted: false };

    const content = input.content.trim();
    if (!content) return { accepted: false };

    const key = `${source}:${id}`;
    const oncePerSession = input.oncePerSession === true;
    const state = this.getOrCreateSession(sessionId);
    if (oncePerSession && state.onceKeys.has(key)) {
      return { accepted: false };
    }

    let entry: ContextInjectionEntry = {
      source,
      id,
      content,
      priority: input.priority ?? "normal",
      estimatedTokens: estimateTokenCount(content),
      timestamp: Date.now(),
      oncePerSession,
      truncated: false,
    };

    const sourceLimit = this.resolveSourceLimit(source);
    if (Number.isFinite(sourceLimit) && entry.estimatedTokens > sourceLimit) {
      const fitted = this.fitEntryToBudget(entry, sourceLimit);
      if (!fitted) return { accepted: false };
      entry = fitted;
    }

    if (entry.estimatedTokens <= 0) return { accepted: false };

    const capacity = this.ensureAppendCapacity(state, entry);
    if (!capacity.allow) {
      return {
        accepted: false,
        sloEnforced: capacity.policyApplied
          ? {
              policy: capacity.policyApplied,
              entriesBefore: capacity.entriesBefore,
              entriesAfter: capacity.entriesAfter,
              dropped: capacity.dropped,
            }
          : undefined,
      };
    }

    const arenaEntry: ArenaEntry = {
      ...entry,
      key,
      index: state.entries.length,
      presented: false,
    };
    state.entries.push(arenaEntry);
    state.latestIndexByKey.set(key, arenaEntry.index);
    this.maybeTrimSupersededEntries(state);

    return {
      accepted: true,
      sloEnforced: capacity.policyApplied
        ? {
            policy: capacity.policyApplied,
            entriesBefore: capacity.entriesBefore,
            entriesAfter: capacity.entriesAfter,
            dropped: capacity.dropped,
          }
        : undefined,
    };
  }

  plan(
    sessionId: string,
    totalTokenBudget: number,
    options?: {
      forceCriticalOnly?: boolean;
      strategyArm?: ContextStrategyArm;
      disableAdaptiveZones?: boolean;
    },
  ): ContextInjectionPlanResult {
    const strategyArm = options?.strategyArm ?? "managed";
    const adaptiveZonesDisabled =
      options?.disableAdaptiveZones === true || strategyArm !== "managed";
    const stabilityForced = options?.forceCriticalOnly === true;
    const state = this.sessions.get(sessionId);
    if (!state || state.latestIndexByKey.size === 0) {
      return {
        text: "",
        entries: [],
        estimatedTokens: 0,
        truncated: false,
        consumedKeys: [],
        planTelemetry: this.emptyPlanTelemetry(strategyArm, adaptiveZonesDisabled, stabilityForced),
      };
    }

    const allCandidates: ArenaEntry[] = [];
    for (const index of state.latestIndexByKey.values()) {
      const entry = state.entries[index];
      if (!entry || entry.presented) continue;
      allCandidates.push(entry);
    }
    const effectiveCandidates = stabilityForced
      ? allCandidates.filter((entry) => CRITICAL_ONLY_ZONES.has(zoneForSource(entry.source)))
      : allCandidates;
    if (effectiveCandidates.length === 0) {
      return {
        text: "",
        entries: [],
        estimatedTokens: 0,
        truncated: false,
        consumedKeys: [],
        planTelemetry: this.consumePlanTelemetry(
          state,
          this.emptyPlanTelemetry(strategyArm, adaptiveZonesDisabled, stabilityForced),
        ),
      };
    }

    const sortEntries = (entries: ArenaEntry[]): ArenaEntry[] => {
      entries.sort((left, right) => {
        if (this.zoneLayout && strategyArm === "managed") {
          const leftZone = zoneOrderIndex(zoneForSource(left.source));
          const rightZone = zoneOrderIndex(zoneForSource(right.source));
          if (leftZone !== rightZone) return leftZone - rightZone;
        }
        const byPriority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
        if (byPriority !== 0) return byPriority;
        return left.timestamp - right.timestamp;
      });
      return entries;
    };

    let candidates = sortEntries([...effectiveCandidates]);
    let zoneDemands = this.buildZoneDemands(candidates);
    let floorUnmetEncountered = false;
    let telemetryFloorRelaxation: ContextZone[] = [];
    let zonePlan: ZonePlanState;

    if (stabilityForced) {
      // In stabilized mode, bypass floor allocation to guarantee bounded cross-turn behavior.
      zonePlan = {
        kind: "disabled",
        floorUnmet: false,
        appliedFloorRelaxation: [],
        allocated: createZeroZoneTokenMap(),
      };
    } else if (strategyArm !== "managed") {
      zonePlan = {
        kind: "disabled",
        floorUnmet: false,
        appliedFloorRelaxation: [],
        allocated: zoneDemands,
      };
    } else {
      zonePlan = this.buildZonePlan(
        sessionId,
        candidates,
        Math.max(0, Math.floor(totalTokenBudget)),
        [],
        adaptiveZonesDisabled,
      );
      floorUnmetEncountered = zonePlan.kind === "floor_unmet";
      telemetryFloorRelaxation = [...zonePlan.appliedFloorRelaxation];

      if (zonePlan.kind === "floor_unmet" && this.floorUnmetPolicy.enabled) {
        const appliedRelaxation: ContextZone[] = [];
        for (const zone of this.floorUnmetPolicy.relaxOrder) {
          appliedRelaxation.push(zone);
          zonePlan = this.buildZonePlan(
            sessionId,
            candidates,
            Math.max(0, Math.floor(totalTokenBudget)),
            appliedRelaxation,
            adaptiveZonesDisabled,
          );
          floorUnmetEncountered = true;
          telemetryFloorRelaxation = [...appliedRelaxation];
          if (zonePlan.kind !== "floor_unmet") {
            break;
          }
        }

        if (
          zonePlan.kind === "floor_unmet" &&
          this.floorUnmetPolicy.finalFallback === "critical_only"
        ) {
          floorUnmetEncountered = true;
          candidates = sortEntries(
            candidates.filter((entry) => CRITICAL_ONLY_ZONES.has(zoneForSource(entry.source))),
          );
          zoneDemands = this.buildZoneDemands(candidates);
          zonePlan = this.buildZonePlan(
            sessionId,
            candidates,
            Math.max(0, Math.floor(totalTokenBudget)),
            [],
            adaptiveZonesDisabled,
          );
        }
      }
    }

    if (zonePlan.kind === "floor_unmet") {
      const adaptation = this.observeAdaptiveTelemetry(
        sessionId,
        {
          zoneDemandTokens: zoneDemands,
          zoneAllocatedTokens: createZeroZoneTokenMap(),
          zoneAcceptedTokens: createZeroZoneTokenMap(),
        },
        adaptiveZonesDisabled,
      );
      return {
        text: "",
        entries: [],
        estimatedTokens: 0,
        truncated: false,
        consumedKeys: [],
        planReason: "floor_unmet",
        planTelemetry: this.consumePlanTelemetry(state, {
          strategyArm,
          zoneDemandTokens: zoneDemands,
          zoneAllocatedTokens: createZeroZoneTokenMap(),
          zoneAcceptedTokens: createZeroZoneTokenMap(),
          adaptiveZonesDisabled,
          stabilityForced,
          floorUnmet: true,
          appliedFloorRelaxation: telemetryFloorRelaxation,
          degradationApplied: null,
          zoneAdaptation: adaptation,
        }),
      };
    }

    const separatorTokens = estimateTokenCount(ENTRY_SEPARATOR);
    let remainingTokens = Math.max(0, Math.floor(totalTokenBudget));
    let truncated = false;
    const consumedKeys: string[] = [];
    const accepted: ContextInjectionEntry[] = [];
    const acceptedByZone = createZeroZoneTokenMap();

    for (const entry of candidates) {
      const separatorCost = accepted.length > 0 ? separatorTokens : 0;
      if (remainingTokens <= separatorCost) {
        truncated = true;
        break;
      }

      const zone = zoneForSource(entry.source);
      const globalEntryBudget = Math.max(0, remainingTokens - separatorCost);
      const zoneBudget = zonePlan.kind === "ready" ? zonePlan.remaining[zone] : globalEntryBudget;
      const entryBudget = Math.max(0, Math.min(globalEntryBudget, zoneBudget));
      if (entryBudget <= 0) {
        truncated = true;
        continue;
      }
      if (entry.estimatedTokens <= entryBudget) {
        consumedKeys.push(entry.key);
        accepted.push(this.toPublicEntry(entry));
        acceptedByZone[zone] += entry.estimatedTokens;
        remainingTokens = Math.max(0, remainingTokens - separatorCost - entry.estimatedTokens);
        if (zonePlan.kind === "ready") {
          zonePlan.remaining[zone] = Math.max(0, zonePlan.remaining[zone] - entry.estimatedTokens);
        }
        continue;
      }

      const fitted = this.fitEntryToBudget(entry, entryBudget);
      truncated = true;
      if (fitted) {
        consumedKeys.push(entry.key);
        accepted.push(fitted);
        acceptedByZone[zone] += fitted.estimatedTokens;
        remainingTokens = Math.max(0, remainingTokens - separatorCost - fitted.estimatedTokens);
        if (zonePlan.kind === "ready") {
          zonePlan.remaining[zone] = Math.max(0, zonePlan.remaining[zone] - fitted.estimatedTokens);
        }

        if (this.truncationStrategy === "tail") {
          break;
        }
        continue;
      }

      if (this.truncationStrategy === "drop-entry" || this.truncationStrategy === "summarize") {
        continue;
      }
      break;
    }

    const text = accepted.map((entry) => entry.content).join(ENTRY_SEPARATOR);
    const adaptation = this.observeAdaptiveTelemetry(
      sessionId,
      {
        zoneDemandTokens: zoneDemands,
        zoneAllocatedTokens: zonePlan.allocated,
        zoneAcceptedTokens: acceptedByZone,
      },
      adaptiveZonesDisabled,
    );
    return {
      text,
      entries: accepted,
      estimatedTokens: estimateTokenCount(text),
      truncated,
      consumedKeys,
      planTelemetry: this.consumePlanTelemetry(state, {
        strategyArm,
        zoneDemandTokens: zoneDemands,
        zoneAllocatedTokens: zonePlan.allocated,
        zoneAcceptedTokens: acceptedByZone,
        adaptiveZonesDisabled,
        stabilityForced,
        floorUnmet: floorUnmetEncountered || zonePlan.floorUnmet,
        appliedFloorRelaxation: floorUnmetEncountered
          ? telemetryFloorRelaxation
          : zonePlan.appliedFloorRelaxation,
        degradationApplied: null,
        zoneAdaptation: adaptation,
      }),
    };
  }

  markPresented(sessionId: string, consumedKeys: string[]): void {
    if (consumedKeys.length === 0) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;

    for (const key of consumedKeys) {
      const index = state.latestIndexByKey.get(key);
      if (index === undefined) continue;
      const entry = state.entries[index];
      if (!entry) continue;
      entry.presented = true;
      if (entry.oncePerSession) {
        state.onceKeys.add(key);
      }
    }
  }

  clearPending(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const index of state.latestIndexByKey.values()) {
      const entry = state.entries[index];
      if (!entry) continue;
      if (entry.oncePerSession && state.onceKeys.has(entry.key)) {
        continue;
      }
      entry.presented = false;
    }
  }

  resetEpoch(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.adaptiveController?.resetEpoch(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.adaptiveController?.clearSession(sessionId);
  }

  snapshot(sessionId: string): ArenaSnapshot {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return {
        totalAppended: 0,
        activeKeys: 0,
        onceKeys: 0,
        adaptiveController: null,
      };
    }
    return {
      totalAppended: state.entries.length,
      activeKeys: state.latestIndexByKey.size,
      onceKeys: state.onceKeys.size,
      adaptiveController: this.adaptiveController?.snapshot(sessionId) ?? null,
    };
  }

  private fitEntryToBudget(
    entry: ContextInjectionEntry,
    tokenBudget: number,
  ): ContextInjectionEntry | null {
    const budget = Math.max(0, Math.floor(tokenBudget));
    if (budget <= 0) return null;
    if (entry.estimatedTokens <= budget) {
      return this.toPublicEntry(entry);
    }

    if (this.truncationStrategy === "drop-entry") {
      return null;
    }

    if (this.truncationStrategy === "summarize") {
      const summary = truncateTextToTokenBudget(this.buildTruncatedSummary(entry), budget);
      const summaryTokens = estimateTokenCount(summary);
      if (summaryTokens <= 0) return null;
      return {
        ...this.toPublicEntry(entry),
        content: summary,
        estimatedTokens: summaryTokens,
        truncated: true,
      };
    }

    const partialText = truncateTextToTokenBudget(entry.content, budget);
    const partialTokens = estimateTokenCount(partialText);
    if (partialTokens <= 0) return null;
    return {
      ...this.toPublicEntry(entry),
      content: partialText,
      estimatedTokens: partialTokens,
      truncated: true,
    };
  }

  private buildTruncatedSummary(entry: ContextInjectionEntry): string {
    return [
      "[ContextTruncated]",
      `source=${entry.source}`,
      `id=${entry.id}`,
      `originalTokens=${entry.estimatedTokens}`,
      "reason=budget_limit",
    ].join("\n");
  }

  private resolveSourceLimit(source: string): number {
    const configured = this.sourceTokenLimits[source];
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, Math.floor(configured));
  }

  private getOrCreateSession(sessionId: string): ArenaSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state: ArenaSessionState = {
      entries: [],
      latestIndexByKey: new Map(),
      onceKeys: new Set(),
      lastDegradationPolicy: null,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private toPublicEntry(entry: ContextInjectionEntry): ContextInjectionEntry {
    return {
      source: entry.source,
      id: entry.id,
      content: entry.content,
      priority: entry.priority,
      estimatedTokens: entry.estimatedTokens,
      timestamp: entry.timestamp,
      oncePerSession: entry.oncePerSession,
      truncated: entry.truncated,
    };
  }

  private buildZoneDemands(candidates: ArenaEntry[]): ZoneTokenMap {
    const zoneDemands = createZeroZoneTokenMap();
    for (const candidate of candidates) {
      const zone = zoneForSource(candidate.source);
      zoneDemands[zone] += candidate.estimatedTokens;
    }
    return zoneDemands;
  }

  private resolveZoneBudgetConfig(
    sessionId: string,
    disableAdaptiveZones: boolean,
  ): ZoneBudgetConfig | null {
    if (!this.baseZoneBudgets) return null;
    if (disableAdaptiveZones || !this.adaptiveController) return this.baseZoneBudgets;
    return this.adaptiveController.resolveZoneBudgetConfig(sessionId);
  }

  private buildZonePlan(
    sessionId: string,
    candidates: ArenaEntry[],
    totalBudget: number,
    floorRelaxation: ContextZone[],
    disableAdaptiveZones: boolean,
  ): ZonePlanState {
    if (!this.zoneLayout || !this.baseZoneBudgets) {
      return {
        kind: "disabled",
        floorUnmet: false,
        appliedFloorRelaxation: [],
        allocated: this.buildZoneDemands(candidates),
      };
    }

    const zoneDemands = this.buildZoneDemands(candidates);
    const effectiveBudgetConfig = this.resolveZoneBudgetConfig(sessionId, disableAdaptiveZones);
    if (!effectiveBudgetConfig) {
      return {
        kind: "disabled",
        floorUnmet: false,
        appliedFloorRelaxation: [],
        allocated: zoneDemands,
      };
    }

    const adjustedZoneBudgetConfig = { ...effectiveBudgetConfig };
    for (const zone of floorRelaxation) {
      adjustedZoneBudgetConfig[zone] = {
        min: 0,
        max: adjustedZoneBudgetConfig[zone].max,
      };
    }

    const allocation = new ZoneBudgetAllocator(adjustedZoneBudgetConfig).allocate({
      totalBudget,
      zoneDemands,
    });
    if (!allocation.accepted) {
      return {
        kind: "floor_unmet",
        floorUnmet: true,
        appliedFloorRelaxation: [...floorRelaxation],
        allocated: createZeroZoneTokenMap(),
      };
    }

    const allocated = this.toZoneMap(allocation);
    return {
      kind: "ready",
      floorUnmet: floorRelaxation.length > 0,
      appliedFloorRelaxation: [...floorRelaxation],
      allocated,
      remaining: { ...allocated },
    };
  }

  private ensureAppendCapacity(
    state: ArenaSessionState,
    entry: ContextInjectionEntry,
  ): ArenaCapacityDecision {
    const before = state.entries.length;
    if (before < this.maxEntriesPerSession) {
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: before,
        dropped: false,
      };
    }

    this.compactToLatest(state);
    if (state.entries.length < this.maxEntriesPerSession) {
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: state.entries.length,
        dropped: false,
      };
    }

    const incomingZone = zoneForSource(entry.source);
    if (this.degradationPolicy === "force_compact") {
      state.entries = [];
      state.latestIndexByKey.clear();
      state.lastDegradationPolicy = this.degradationPolicy;
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: 0,
        policyApplied: this.degradationPolicy,
        dropped: false,
      };
    }

    if (this.degradationPolicy === "drop_recall") {
      if (incomingZone === "memory_recall" || incomingZone === "rag_external") {
        state.lastDegradationPolicy = this.degradationPolicy;
        return {
          allow: false,
          entriesBefore: before,
          entriesAfter: state.entries.length,
          policyApplied: this.degradationPolicy,
          dropped: true,
        };
      }

      const evicted = this.evictActiveEntry(state, (candidate) => {
        const zone = zoneForSource(candidate.source);
        return zone === "memory_recall" || zone === "rag_external";
      });
      if (!evicted) {
        state.lastDegradationPolicy = this.degradationPolicy;
        return {
          allow: false,
          entriesBefore: before,
          entriesAfter: state.entries.length,
          policyApplied: this.degradationPolicy,
          dropped: true,
        };
      }

      state.lastDegradationPolicy = this.degradationPolicy;
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: state.entries.length,
        policyApplied: this.degradationPolicy,
        dropped: false,
      };
    }

    if (this.degradationPolicy === "drop_low_priority") {
      const incomingPriority = entry.priority;
      if (incomingPriority === "low" || incomingPriority === "normal") {
        state.lastDegradationPolicy = this.degradationPolicy;
        return {
          allow: false,
          entriesBefore: before,
          entriesAfter: state.entries.length,
          policyApplied: this.degradationPolicy,
          dropped: true,
        };
      }

      const evicted = this.evictActiveEntry(
        state,
        (candidate) => candidate.priority === "low" || candidate.priority === "normal",
      );
      if (evicted) {
        state.lastDegradationPolicy = this.degradationPolicy;
        return {
          allow: true,
          entriesBefore: before,
          entriesAfter: state.entries.length,
          policyApplied: this.degradationPolicy,
          dropped: false,
        };
      }

      state.lastDegradationPolicy = this.degradationPolicy;
      return {
        allow: false,
        entriesBefore: before,
        entriesAfter: state.entries.length,
        policyApplied: this.degradationPolicy,
        dropped: true,
      };
    }

    return {
      allow: false,
      entriesBefore: before,
      entriesAfter: state.entries.length,
      dropped: true,
    };
  }

  private evictActiveEntry(
    state: ArenaSessionState,
    predicate: (entry: ArenaEntry) => boolean,
  ): boolean {
    const activeEntries: ArenaEntry[] = [];
    for (const index of state.latestIndexByKey.values()) {
      const entry = state.entries[index];
      if (!entry) continue;
      activeEntries.push(entry);
    }
    const candidate = activeEntries
      .filter((entry) => predicate(entry))
      .toSorted((left, right) => left.timestamp - right.timestamp)[0];
    if (!candidate) return false;
    state.latestIndexByKey.delete(candidate.key);
    this.compactToLatest(state);
    return true;
  }

  private compactToLatest(state: ArenaSessionState): void {
    const latestIndices = new Set(state.latestIndexByKey.values());
    const compactedEntries: ArenaEntry[] = [];
    const nextLatestIndexByKey = new Map<string, number>();

    for (const entry of state.entries) {
      if (!latestIndices.has(entry.index)) continue;
      const nextIndex = compactedEntries.length;
      compactedEntries.push({
        ...entry,
        index: nextIndex,
      });
      nextLatestIndexByKey.set(entry.key, nextIndex);
    }

    state.entries = compactedEntries;
    state.latestIndexByKey = nextLatestIndexByKey;
  }

  private maybeTrimSupersededEntries(state: ArenaSessionState): void {
    const totalEntries = state.entries.length;
    if (totalEntries < ARENA_TRIM_MIN_ENTRIES) return;

    const latestIndices = new Set(state.latestIndexByKey.values());
    const supersededCount = totalEntries - latestIndices.size;
    if (supersededCount < ARENA_TRIM_MIN_SUPERSEDED) return;
    if (supersededCount / totalEntries < ARENA_TRIM_MIN_SUPERSEDED_RATIO) return;

    this.compactToLatest(state);
  }

  private toZoneMap(allocation: ZoneBudgetAllocationResult): ZoneTokenMap {
    return {
      identity: allocation.identity,
      truth: allocation.truth,
      task_state: allocation.task_state,
      tool_failures: allocation.tool_failures,
      memory_working: allocation.memory_working,
      memory_recall: allocation.memory_recall,
      rag_external: allocation.rag_external,
    };
  }

  private observeAdaptiveTelemetry(
    sessionId: string,
    telemetry: ZoneBudgetPlanTelemetry,
    disableAdaptiveZones: boolean,
  ): ZoneBudgetControllerAdjustment | null {
    if (disableAdaptiveZones || !this.adaptiveController) return null;
    return this.adaptiveController.observe(sessionId, telemetry);
  }

  private emptyPlanTelemetry(
    strategyArm: ContextStrategyArm = "managed",
    adaptiveZonesDisabled = false,
    stabilityForced = false,
  ): ContextInjectionPlanResult["planTelemetry"] {
    return {
      strategyArm,
      zoneDemandTokens: createZeroZoneTokenMap(),
      zoneAllocatedTokens: createZeroZoneTokenMap(),
      zoneAcceptedTokens: createZeroZoneTokenMap(),
      adaptiveZonesDisabled,
      stabilityForced,
      floorUnmet: false,
      appliedFloorRelaxation: [],
      degradationApplied: null,
      zoneAdaptation: null,
    };
  }

  private consumePlanTelemetry(
    state: ArenaSessionState,
    telemetry: ContextInjectionPlanResult["planTelemetry"],
  ): ContextInjectionPlanResult["planTelemetry"] {
    const degradationApplied = state.lastDegradationPolicy;
    state.lastDegradationPolicy = null;
    return {
      ...telemetry,
      degradationApplied: degradationApplied ?? telemetry.degradationApplied,
    };
  }
}
