import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { format, getHours } from "date-fns";
import type {
  CognitiveInferRelationOutput,
  CognitivePort,
  CognitiveTokenBudgetStatus,
  CognitiveUsage,
} from "../cognitive/port.js";
import {
  cognitiveBudgetPayload,
  cognitiveUsagePayload,
  normalizeCognitiveRankResult,
  normalizeCognitiveUsage,
} from "../cognitive/usage.js";
import type { BrewvaEventRecord } from "../types.js";
import { writeFileAtomic } from "../utils/fs.js";
import { normalizeJsonRecord } from "../utils/json.js";
import { compileCrystalDrafts } from "./crystal.js";
import { extractMemoryFromEvent } from "./extractor.js";
import {
  GlobalMemoryTier,
  GLOBAL_MEMORY_SESSION_ID,
  type GlobalMemorySnapshot,
} from "./global-tier.js";
import { searchMemory, type MemoryRetrievalWeights } from "./retrieval.js";
import { MemoryStore } from "./store.js";
import type {
  MemoryCrystal,
  MemoryEvolvesEdge,
  MemoryKnowledgeFacets,
  MemoryInsight,
  MemorySearchResult,
  MemoryUnit,
  WorkingMemorySnapshot,
} from "./types.js";
import { MEMORY_RANKING_SIGNAL_SCHEMA, MEMORY_SEARCH_RESULT_SCHEMA } from "./types.js";
import { buildWorkingMemorySnapshot } from "./working-memory.js";

const GLOBAL_LIFECYCLE_COOLDOWN_MS = 60_000;
const GLOBAL_SYNC_SNAPSHOT_DIR = "global-sync";
const COGNITIVE_MAX_INFERENCE_CALLS_PER_REFRESH = 6;
const COGNITIVE_MAX_RANK_CANDIDATES_PER_SEARCH = 8;

function toDayKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function clampProbability(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function sanitizeRationale(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const maxChars = 500;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

function sanitizeRankScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function normalizeTopicKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatRecallKnowledgeFacets(facets: MemoryKnowledgeFacets | undefined): string | null {
  if (!facets) return null;
  const parts: string[] = [];
  if (facets.pattern) {
    parts.push(`pattern=${facets.pattern}`);
  }
  if (facets.rootCause) {
    parts.push(`root_cause=${facets.rootCause}`);
  }
  if (facets.recommendation) {
    parts.push(`recommendation=${facets.recommendation}`);
  }
  if (facets.outcomes.pass > 0 || facets.outcomes.fail > 0) {
    parts.push(`outcomes=pass:${facets.outcomes.pass},fail:${facets.outcomes.fail}`);
  }
  if (parts.length === 0) return null;
  return `facets: ${parts.join("; ")}`;
}

function inferEvolvesRelation(input: {
  newerFingerprint: string;
  olderFingerprint: string;
  newer: string;
  older: string;
}): MemoryEvolvesEdge["relation"] {
  if (input.newerFingerprint === input.olderFingerprint) return "confirms";
  const newer = input.newer.toLowerCase().replace(/\s+/g, " ").trim();
  const older = input.older.toLowerCase().replace(/\s+/g, " ").trim();
  if (newer === older) return "confirms";

  const tokenize = (text: string): Set<string> =>
    new Set(text.match(/[\p{L}\p{N}_]+/gu)?.map((token) => token.toLowerCase()) ?? []);
  const newerTokens = tokenize(newer);
  const olderTokens = tokenize(older);
  let overlap = 0;
  for (const token of newerTokens) {
    if (olderTokens.has(token)) overlap += 1;
  }
  const unionSize = Math.max(1, newerTokens.size + olderTokens.size - overlap);
  const jaccard = overlap / unionSize;
  if (newer.includes(older) || older.includes(newer) || jaccard >= 0.82) return "enriches";

  const replacePattern =
    /\b(instead of|replace(?:s|d)?|switched?\s+to|migrat(?:e|es|ed|ing)\s+to|deprecat(?:e|es|ed|ing)|drop(?:s|ped)?|remove(?:s|d)?)\b/;
  if (replacePattern.test(newer)) return "replaces";

  const challengePattern =
    /(?:^|[;,.]\s+)(however|but|in contrast|on the other hand|rather than)\b/;
  if (challengePattern.test(newer) && jaccard >= 0.2) return "challenges";
  if (jaccard >= 0.45) return "enriches";
  return "enriches";
}

function normalizeRetrievalWeights(
  input: MemoryRetrievalWeights | undefined,
): MemoryRetrievalWeights {
  const lexical = Math.max(0, input?.lexical ?? 0.55);
  const recency = Math.max(0, input?.recency ?? 0.25);
  const confidence = Math.max(0, input?.confidence ?? 0.2);
  const total = lexical + recency + confidence;
  if (total <= 0) {
    return {
      lexical: 0.55,
      recency: 0.25,
      confidence: 0.2,
    };
  }
  return {
    lexical: lexical / total,
    recency: recency / total,
    confidence: confidence / total,
  };
}

export interface MemoryEngineOptions {
  enabled: boolean;
  rootDir: string;
  workingFile: string;
  maxWorkingChars: number;
  dailyRefreshHourLocal: number;
  crystalMinUnits: number;
  retrievalTopK: number;
  retrievalWeights?: MemoryRetrievalWeights;
  evolvesMode: "off" | "shadow";
  cognitiveMode?: "off" | "shadow" | "active";
  cognitiveMaxInferenceCallsPerRefresh?: number;
  cognitiveMaxRankCandidatesPerSearch?: number;
  cognitivePort?: CognitivePort;
  getCognitiveBudgetStatus?: (sessionId: string) => CognitiveTokenBudgetStatus;
  recordCognitiveUsage?: (input: {
    sessionId: string;
    stage: string;
    usage: CognitiveUsage;
  }) => CognitiveTokenBudgetStatus;
  globalEnabled?: boolean;
  globalMinConfidence?: number;
  globalMinSessionRecurrence?: number;
  globalDecayIntervalDays?: number;
  globalDecayFactor?: number;
  globalPruneBelowConfidence?: number;
  globalLifecycleCooldownMs?: number;
  recordEvent?: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }) => void;
}

export interface MemoryRebuildFromTapeResult {
  rebuilt: boolean;
  reason: "disabled" | "already_present" | "no_replayable_events" | "replayed";
  scannedEvents: number;
  replayedEvents: number;
  upsertedUnits: number;
  resolvedUnits: number;
}

export class MemoryEngine {
  private readonly enabled: boolean;
  private readonly rootDir: string;
  private readonly workingFile: string;
  private readonly maxWorkingChars: number;
  private readonly dailyRefreshHourLocal: number;
  private readonly crystalMinUnits: number;
  private readonly retrievalTopK: number;
  private readonly retrievalWeights: MemoryRetrievalWeights;
  private readonly evolvesMode: "off" | "shadow";
  private readonly cognitiveMode: "off" | "shadow" | "active";
  private readonly cognitiveMaxInferenceCallsPerRefresh: number;
  private readonly cognitiveMaxRankCandidatesPerSearch: number;
  private readonly cognitivePort?: CognitivePort;
  private readonly getCognitiveBudgetStatus?: (sessionId: string) => CognitiveTokenBudgetStatus;
  private readonly recordCognitiveUsage?: (input: {
    sessionId: string;
    stage: string;
    usage: CognitiveUsage;
  }) => CognitiveTokenBudgetStatus;
  private readonly globalEnabled: boolean;
  private readonly globalMinConfidence: number;
  private readonly globalMinSessionRecurrence: number;
  private readonly globalDecayIntervalDays: number;
  private readonly globalDecayFactor: number;
  private readonly globalPruneBelowConfidence: number;
  private readonly globalLifecycleCooldownMs: number;
  private readonly recordEvent?: MemoryEngineOptions["recordEvent"];
  private store: MemoryStore | null = null;
  private globalTier: GlobalMemoryTier | null = null;
  private globalLifecycleLastRunAt = 0;

  constructor(options: MemoryEngineOptions) {
    this.enabled = options.enabled;
    this.rootDir = options.rootDir;
    this.workingFile = options.workingFile;
    this.maxWorkingChars = Math.max(200, options.maxWorkingChars);
    this.dailyRefreshHourLocal = Math.max(0, Math.min(23, options.dailyRefreshHourLocal));
    this.crystalMinUnits = Math.max(2, options.crystalMinUnits);
    this.retrievalTopK = Math.max(1, options.retrievalTopK);
    this.retrievalWeights = normalizeRetrievalWeights(options.retrievalWeights);
    this.evolvesMode = options.evolvesMode;
    this.cognitiveMode = options.cognitiveMode ?? "off";
    this.cognitiveMaxInferenceCallsPerRefresh = Math.max(
      0,
      Math.trunc(
        options.cognitiveMaxInferenceCallsPerRefresh ?? COGNITIVE_MAX_INFERENCE_CALLS_PER_REFRESH,
      ),
    );
    this.cognitiveMaxRankCandidatesPerSearch = Math.max(
      0,
      Math.trunc(
        options.cognitiveMaxRankCandidatesPerSearch ?? COGNITIVE_MAX_RANK_CANDIDATES_PER_SEARCH,
      ),
    );
    this.cognitivePort = options.cognitivePort;
    this.getCognitiveBudgetStatus = options.getCognitiveBudgetStatus;
    this.recordCognitiveUsage = options.recordCognitiveUsage;
    this.globalEnabled = options.globalEnabled ?? false;
    this.globalMinConfidence = clampProbability(options.globalMinConfidence ?? 0.8, 0.8);
    this.globalMinSessionRecurrence = Math.max(
      2,
      Math.trunc(options.globalMinSessionRecurrence ?? 2),
    );
    this.globalDecayIntervalDays = Math.max(1, Math.trunc(options.globalDecayIntervalDays ?? 7));
    this.globalDecayFactor = clampProbability(options.globalDecayFactor ?? 0.95, 0.95);
    this.globalPruneBelowConfidence = clampProbability(
      options.globalPruneBelowConfidence ?? 0.3,
      0.3,
    );
    this.globalLifecycleCooldownMs = Math.max(
      0,
      options.globalLifecycleCooldownMs ?? GLOBAL_LIFECYCLE_COOLDOWN_MS,
    );
    this.recordEvent = options.recordEvent;
  }

  ingestEvent(event: BrewvaEventRecord): void {
    if (!this.enabled) return;
    if (event.type.startsWith("memory_")) return;

    const extraction = extractMemoryFromEvent(event);
    if (extraction.upserts.length === 0 && extraction.resolves.length === 0) {
      return;
    }

    const store = this.getStore();
    const dirtyTopicsFromUnits: string[] = [];
    const dirtyTopicsFromResolves: string[] = [];
    for (const candidate of extraction.upserts) {
      const result = store.upsertUnit(candidate);
      const taskKind =
        typeof result.unit.metadata?.taskKind === "string" ? result.unit.metadata.taskKind : null;
      const memorySignal =
        typeof result.unit.metadata?.memorySignal === "string"
          ? result.unit.metadata.memorySignal
          : null;
      if (taskKind !== "status_set" || memorySignal === "verification") {
        dirtyTopicsFromUnits.push(result.unit.topic);
      }
      this.recordEvent?.({
        sessionId: event.sessionId,
        type: "memory_unit_upserted",
        turn: event.turn,
        payload: {
          unitId: result.unit.id,
          topic: result.unit.topic,
          unitType: result.unit.type,
          created: result.created,
          confidence: result.unit.confidence,
          unit: result.unit as unknown as Record<string, unknown>,
        },
      });
    }
    for (const directive of extraction.resolves) {
      const resolvedCount = store.resolveUnits(directive);
      if (resolvedCount > 0) {
        dirtyTopicsFromResolves.push(`${directive.sourceType}:${directive.sourceId}`);
      }
    }
    if (dirtyTopicsFromUnits.length > 0) {
      store.mergeDirtyTopics(dirtyTopicsFromUnits, { reason: "new_unit" });
    }
    if (dirtyTopicsFromResolves.length > 0) {
      store.mergeDirtyTopics(dirtyTopicsFromResolves, { reason: "resolve_directive" });
    }
  }

  refreshIfNeeded(input: { sessionId: string }): WorkingMemorySnapshot | undefined {
    if (!this.enabled) return undefined;
    const now = new Date();
    const store = this.getStore();
    const state = store.getState();
    const today = toDayKey(now);
    const crossedDailyHour = getHours(now) >= this.dailyRefreshHourLocal;
    const needsDailyRefresh = crossedDailyHour && state.lastPublishedDayKey !== today;
    const needsEventRefresh = state.dirtyEntries.length > 0;
    const needsRefresh = needsDailyRefresh || needsEventRefresh;

    if (!needsRefresh) {
      const cached = store.getWorkingSnapshot(input.sessionId);
      if (cached) return cached;
    }

    const refreshResult = store.withRefreshLock(() => {
      const rechecked = store.getState();
      const stillNeedsDailyRefresh = crossedDailyHour && rechecked.lastPublishedDayKey !== today;
      const stillNeedsEventRefresh = rechecked.dirtyEntries.length > 0;
      if (!stillNeedsDailyRefresh && !stillNeedsEventRefresh) {
        const cached = store.getWorkingSnapshot(input.sessionId);
        if (cached) return cached;

        const existing = store.getWorkingText();
        if (existing) {
          return {
            sessionId: input.sessionId,
            generatedAt: rechecked.lastPublishedAt ?? Date.now(),
            sourceUnitIds: [],
            crystalIds: [],
            insightIds: [],
            sections: [],
            content: existing,
          };
        }

        // Bootstrap a deterministic baseline snapshot when memory is enabled but
        // no prior working snapshot exists yet.
        const units = store.listUnits(input.sessionId);
        const crystals = store.listCrystals(input.sessionId);
        const insights = this.collectInsights(input.sessionId, units);
        const snapshot = buildWorkingMemorySnapshot({
          sessionId: input.sessionId,
          units,
          crystals,
          insights,
          maxChars: this.maxWorkingChars,
        });
        store.publishWorking(snapshot, this.maxWorkingChars);
        store.markPublished({
          at: snapshot.generatedAt,
          dayKey: today,
        });
        this.recordEvent?.({
          sessionId: input.sessionId,
          type: "memory_working_published",
          payload: {
            generatedAt: snapshot.generatedAt,
            units: snapshot.sourceUnitIds.length,
            crystals: snapshot.crystalIds.length,
            insights: snapshot.insightIds.length,
            chars: snapshot.content.length,
            working: snapshot as unknown as Record<string, unknown>,
          },
        });
        return snapshot;
      }

      const units = store.listUnits(input.sessionId);
      if (this.globalEnabled) {
        const nowMs = Date.now();
        if (nowMs - this.globalLifecycleLastRunAt >= this.globalLifecycleCooldownMs) {
          this.globalLifecycleLastRunAt = nowMs;
          const tier = this.getGlobalTier();
          if (tier) {
            const lifecycle = tier.runLifecycle({
              sessionId: input.sessionId,
              sessionUnits: units,
              allUnits: store.listUnits(),
            });
            if (
              lifecycle.promoted > 0 ||
              lifecycle.refreshed > 0 ||
              lifecycle.decayed > 0 ||
              lifecycle.pruned > 0 ||
              lifecycle.resolvedByPass > 0 ||
              lifecycle.crystalsCompiled > 0 ||
              lifecycle.crystalsRemoved > 0
            ) {
              const globalSnapshot = tier.snapshot();
              const globalSnapshotRef = this.persistGlobalSyncSnapshot(globalSnapshot);
              this.recordEvent?.({
                sessionId: input.sessionId,
                type: "memory_global_sync",
                payload: {
                  stage: "refresh",
                  scannedCandidates: lifecycle.scannedCandidates,
                  promoted: lifecycle.promoted,
                  refreshed: lifecycle.refreshed,
                  decayed: lifecycle.decayed,
                  pruned: lifecycle.pruned,
                  resolvedByPass: lifecycle.resolvedByPass,
                  crystalsCompiled: lifecycle.crystalsCompiled,
                  crystalsRemoved: lifecycle.crystalsRemoved,
                  promotedUnitIds: lifecycle.promotedUnitIds,
                  globalSummary: {
                    schema: globalSnapshot.schema,
                    generatedAt: globalSnapshot.generatedAt,
                    unitCount: globalSnapshot.units.length,
                    crystalCount: globalSnapshot.crystals.length,
                  },
                  globalSnapshotRef,
                },
              });
            }
          }
        }
      }
      const drafts = compileCrystalDrafts({
        sessionId: input.sessionId,
        units,
        minUnits: this.crystalMinUnits,
      });
      const crystals = drafts.map((draft) => {
        const crystal = store.upsertCrystal(draft);
        this.recordEvent?.({
          sessionId: input.sessionId,
          type: "memory_crystal_compiled",
          payload: {
            crystalId: crystal.id,
            topic: crystal.topic,
            unitCount: crystal.unitIds.length,
            confidence: crystal.confidence,
            crystal: crystal as unknown as Record<string, unknown>,
          },
        });
        return crystal;
      });

      if (this.evolvesMode === "shadow") {
        this.maybeCreateEvolvesEdges(input.sessionId, units);
      }

      const insights = this.collectInsights(input.sessionId, units);
      const snapshot = buildWorkingMemorySnapshot({
        sessionId: input.sessionId,
        units,
        crystals,
        insights,
        maxChars: this.maxWorkingChars,
      });
      store.publishWorking(snapshot, this.maxWorkingChars);
      store.markPublished({
        at: snapshot.generatedAt,
        dayKey: today,
      });
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "memory_working_published",
        payload: {
          generatedAt: snapshot.generatedAt,
          units: snapshot.sourceUnitIds.length,
          crystals: snapshot.crystalIds.length,
          insights: snapshot.insightIds.length,
          chars: snapshot.content.length,
          working: snapshot as unknown as Record<string, unknown>,
        },
      });
      return snapshot;
    });
    if (refreshResult.acquired) return refreshResult.value;

    const cached = store.getWorkingSnapshot(input.sessionId);
    if (cached) return cached;
    const text = store.getWorkingText();
    if (!text) return undefined;
    return {
      sessionId: input.sessionId,
      generatedAt: state.lastPublishedAt ?? Date.now(),
      sourceUnitIds: [],
      crystalIds: [],
      insightIds: [],
      sections: [],
      content: text,
    };
  }

  getWorkingMemory(sessionId: string): WorkingMemorySnapshot | undefined {
    if (!this.enabled) return undefined;
    const store = this.getStore();
    const cached = store.getWorkingSnapshot(sessionId);
    if (cached) return cached;

    const text = store.getWorkingText();
    if (!text) return undefined;
    const state = store.getState();
    return {
      sessionId,
      generatedAt: state.lastPublishedAt ?? Date.now(),
      sourceUnitIds: [],
      crystalIds: [],
      insightIds: [],
      sections: [],
      content: text,
    };
  }

  getOpenInsightTerms(sessionId: string, limit = 8): string[] {
    if (!this.enabled) return [];
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const store = this.getStore();
    const insights = store.listInsights(sessionId).filter((insight) => insight.status === "open");
    if (insights.length === 0) return [];
    const relatedUnitIds = new Set<string>();
    for (const insight of insights) {
      for (const unitId of insight.relatedUnitIds) {
        const normalized = unitId.trim();
        if (!normalized) continue;
        relatedUnitIds.add(normalized);
      }
    }
    if (relatedUnitIds.size === 0) return [];

    const terms: string[] = [];
    const seen = new Set<string>();
    for (const unitId of relatedUnitIds) {
      const unit = store.getUnitById(unitId);
      if (!unit) continue;
      const topic = unit.topic.trim();
      const candidate = topic || unit.statement.trim();
      if (!candidate) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const maxChars = 160;
      terms.push(candidate.length > maxChars ? candidate.slice(0, maxChars) : candidate);
      if (terms.length >= normalizedLimit) break;
    }
    return terms;
  }

  private buildSearchResult(
    sessionId: string,
    input: { query: string; limit?: number },
  ): MemorySearchResult {
    if (!this.enabled) {
      return {
        schema: MEMORY_SEARCH_RESULT_SCHEMA,
        version: 1,
        generatedAt: Date.now(),
        rankingModel: {
          schema: MEMORY_RANKING_SIGNAL_SCHEMA,
          lexicalWeight: this.retrievalWeights.lexical,
          recencyWeight: this.retrievalWeights.recency,
          confidenceWeight: this.retrievalWeights.confidence,
        },
        sessionId,
        query: input.query,
        scanned: 0,
        hits: [],
      };
    }
    const store = this.getStore();
    const globalTier = this.globalEnabled ? this.getGlobalTier() : null;
    const sessionUnits = store.listUnits(sessionId);
    const globalUnits = globalTier?.listUnits() ?? [];
    const sessionCrystals = store.listCrystals(sessionId);
    const globalCrystals = globalTier?.listCrystals() ?? [];

    const activeSessionFingerprints = new Set(
      sessionUnits.filter((unit) => unit.status === "active").map((unit) => unit.fingerprint),
    );
    const uniqueGlobalUnits = globalUnits.filter(
      (unit) => !activeSessionFingerprints.has(unit.fingerprint),
    );
    const sessionCrystalTopics = new Set(
      sessionCrystals.map((crystal) => normalizeTopicKey(crystal.topic)),
    );
    const uniqueGlobalCrystals = globalCrystals.filter(
      (crystal) => !sessionCrystalTopics.has(normalizeTopicKey(crystal.topic)),
    );
    const combinedUnits =
      uniqueGlobalUnits.length > 0 ? [...sessionUnits, ...uniqueGlobalUnits] : sessionUnits;
    const combinedCrystals =
      uniqueGlobalCrystals.length > 0
        ? [...sessionCrystals, ...uniqueGlobalCrystals]
        : sessionCrystals;
    const includeGlobal = uniqueGlobalUnits.length > 0 || uniqueGlobalCrystals.length > 0;
    const result = searchMemory({
      sessionId,
      query: input.query,
      includeSessionIds: includeGlobal ? [GLOBAL_MEMORY_SESSION_ID] : undefined,
      units: combinedUnits,
      crystals: combinedCrystals,
      limit: Math.max(1, input.limit ?? this.retrievalTopK),
      weights: this.retrievalWeights,
    });
    if (includeGlobal) {
      const globalUnitIds = new Set(uniqueGlobalUnits.map((unit) => unit.id));
      const globalCrystalIds = new Set(uniqueGlobalCrystals.map((crystal) => crystal.id));
      const globalHits = result.hits.filter(
        (hit) => globalUnitIds.has(hit.id) || globalCrystalIds.has(hit.id),
      );
      if (globalHits.length > 0) {
        const globalUnitHits = globalHits.filter((hit) => hit.kind === "unit").length;
        const globalCrystalHits = globalHits.filter((hit) => hit.kind === "crystal").length;
        this.recordEvent?.({
          sessionId,
          type: "memory_global_recall",
          payload: {
            schema: result.schema,
            rankingSchema: result.rankingModel.schema,
            query: input.query.trim(),
            totalGlobalUnits: uniqueGlobalUnits.length,
            totalGlobalCrystals: uniqueGlobalCrystals.length,
            matchedGlobalHits: globalHits.length,
            matchedGlobalUnitHits: globalUnitHits,
            matchedGlobalCrystalHits: globalCrystalHits,
            topHitIds: globalHits.slice(0, 5).map((hit) => hit.id),
            topHitSignals: globalHits.slice(0, 5).map((hit) => ({
              id: hit.id,
              rank: hit.ranking.rank,
              score: hit.score,
              weightedLexical: hit.ranking.weightedLexical,
              weightedRecency: hit.ranking.weightedRecency,
              weightedConfidence: hit.ranking.weightedConfidence,
              weakSemantic: hit.ranking.weakSemantic,
            })),
          },
        });
      }
    }
    return result;
  }

  async search(
    sessionId: string,
    input: { query: string; limit?: number },
  ): Promise<MemorySearchResult> {
    const result = this.buildSearchResult(sessionId, input);
    await this.maybeRecordCognitiveRelevanceRanking({
      sessionId,
      query: input.query,
      result,
      allowAsyncApply: true,
    });
    return result;
  }

  async buildRecallBlock(input: {
    sessionId: string;
    query: string;
    limit?: number;
  }): Promise<string> {
    const result = await this.search(input.sessionId, {
      query: input.query,
      limit: input.limit,
    });
    if (result.hits.length === 0) return "";
    const lines: string[] = [
      "[MemoryRecall]",
      `query: ${result.query}`,
      `scanned: ${result.scanned}`,
    ];
    result.hits.forEach((hit, index) => {
      lines.push(
        `${index + 1}. [${hit.kind}] ${hit.topic} score=${hit.score.toFixed(3)} conf=${hit.confidence.toFixed(3)}`,
      );
      lines.push(`   ${hit.excerpt}`);
      const facetsLine = formatRecallKnowledgeFacets(hit.knowledgeFacets);
      if (facetsLine) {
        lines.push(`   ${facetsLine}`);
      }
    });
    return lines.join("\n");
  }

  ingestExternalRecall(input: {
    sessionId: string;
    query: string;
    defaultConfidence: number;
    hits: Array<{
      topic: string;
      excerpt: string;
      score: number;
      confidence?: number;
      metadata?: Record<string, unknown>;
    }>;
  }): { upserted: number } {
    if (!this.enabled) return { upserted: 0 };
    const store = this.getStore();
    const now = Date.now();
    const injectedConfidence = clampProbability(input.defaultConfidence, 0.6);
    let upserted = 0;
    const dirtyTopics: string[] = [];
    input.hits.forEach((hit, index) => {
      const topic = hit.topic.trim();
      const statement = hit.excerpt.trim();
      if (!topic || !statement) return;
      const providerConfidence =
        typeof hit.confidence === "number" && Number.isFinite(hit.confidence)
          ? clampProbability(hit.confidence)
          : null;
      const providerScore = sanitizeRankScore(hit.score);
      const metadataInput: Record<string, unknown> = {};
      if (hit.metadata) {
        Object.assign(metadataInput, hit.metadata);
      }
      metadataInput.sourceTier = "external";
      metadataInput.externalQuery = input.query;
      metadataInput.externalScore = providerScore;
      if (providerConfidence !== null) {
        metadataInput.externalProviderConfidence = providerConfidence;
      }
      const metadata = normalizeJsonRecord(metadataInput);
      const result = store.upsertUnit({
        sessionId: input.sessionId,
        type: "fact",
        status: "active",
        topic,
        statement,
        confidence: injectedConfidence,
        metadata,
        sourceRefs: [
          {
            eventId: `external-recall:${now}:${index}`,
            eventType: "context_external_recall",
            sessionId: input.sessionId,
            timestamp: now,
          },
        ],
      });
      dirtyTopics.push(result.unit.topic);
      upserted += 1;
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "memory_unit_upserted",
        payload: {
          unitId: result.unit.id,
          topic: result.unit.topic,
          unitType: result.unit.type,
          created: result.created,
          confidence: result.unit.confidence,
          sourceTier: "external",
          unit: result.unit as unknown as Record<string, unknown>,
        },
      });
    });
    if (dirtyTopics.length > 0) {
      store.mergeDirtyTopics(dirtyTopics, { reason: "external_recall" });
    }
    return { upserted };
  }

  dismissInsight(sessionId: string, insightId: string): boolean {
    if (!this.enabled) return false;
    const dismissedInsight = this.getStore().dismissInsight(insightId);
    if (dismissedInsight) {
      this.recordEvent?.({
        sessionId,
        type: "memory_insight_dismissed",
        payload: {
          insightId,
          insight: dismissedInsight as unknown as Record<string, unknown>,
        },
      });
    }
    return Boolean(dismissedInsight);
  }

  reviewEvolvesEdge(
    sessionId: string,
    input: { edgeId: string; decision: "accept" | "reject" },
  ): { ok: boolean; error?: "missing_id" | "not_found" | "already_set" } {
    if (!this.enabled) return { ok: false, error: "not_found" };
    const edgeId = input.edgeId.trim();
    if (!edgeId) return { ok: false, error: "missing_id" };
    const status = input.decision === "accept" ? "accepted" : "rejected";
    const store = this.getStore();
    const result = store.setEvolvesEdgeStatus(sessionId, edgeId, status);
    if (!result.ok) return { ok: false, error: "not_found" };
    if (!result.updated) return { ok: false, error: "already_set" };
    this.recordEvent?.({
      sessionId,
      type: "memory_evolves_edge_reviewed",
      payload: {
        edgeId: result.edge.id,
        status: result.edge.status,
        relation: result.edge.relation,
        sourceUnitId: result.edge.sourceUnitId,
        targetUnitId: result.edge.targetUnitId,
        edge: result.edge as unknown as Record<string, unknown>,
      },
    });

    for (const insight of store.listInsights(sessionId)) {
      if (insight.status !== "open") continue;
      if (insight.kind !== "evolves_pending") continue;
      if (insight.edgeId !== result.edge.id) continue;
      this.dismissInsight(sessionId, insight.id);
    }

    if (
      result.edge.status === "accepted" &&
      (result.edge.relation === "replaces" || result.edge.relation === "challenges")
    ) {
      const superseded = store.supersedeUnit({
        sessionId,
        unitId: result.edge.targetUnitId,
        supersededByUnitId: result.edge.sourceUnitId,
        supersededByEdgeId: result.edge.id,
        relation: result.edge.relation,
      });
      if (superseded.ok && superseded.updated) {
        this.recordEvent?.({
          sessionId,
          type: "memory_unit_superseded",
          payload: {
            unitId: superseded.unit.id,
            supersededAt: superseded.unit.supersededAt ?? null,
            supersededByUnitId: result.edge.sourceUnitId,
            edgeId: result.edge.id,
            relation: result.edge.relation,
            unit: superseded.unit as unknown as Record<string, unknown>,
          },
        });
        for (const insight of store.listInsights(sessionId)) {
          if (insight.status !== "open") continue;
          if (insight.kind !== "conflict") continue;
          if (!insight.relatedUnitIds.includes(superseded.unit.id)) continue;
          this.dismissInsight(sessionId, insight.id);
        }
      }
    }

    store.mergeDirtyTopics([`evolves_edge_reviewed:${result.edge.id}`], {
      reason: "evolves_edge_reviewed",
    });
    return { ok: true };
  }

  clearSessionCache(sessionId: string): void {
    this.store?.clearSessionCache(sessionId);
  }

  rebuildSessionFromTape(input: {
    sessionId: string;
    events: BrewvaEventRecord[];
    mode?: "missing_only" | "force";
  }): MemoryRebuildFromTapeResult {
    if (!this.enabled) {
      return {
        rebuilt: false,
        reason: "disabled",
        scannedEvents: input.events.length,
        replayedEvents: 0,
        upsertedUnits: 0,
        resolvedUnits: 0,
      };
    }

    const store = this.getStore();
    const mode = input.mode ?? "missing_only";
    const hasProjectionData =
      store.listUnits(input.sessionId).length > 0 ||
      store.listCrystals(input.sessionId).length > 0 ||
      store.listInsights(input.sessionId).length > 0 ||
      store.listEvolvesEdges(input.sessionId).length > 0;
    if (mode === "missing_only" && hasProjectionData) {
      return {
        rebuilt: false,
        reason: "already_present",
        scannedEvents: input.events.length,
        replayedEvents: 0,
        upsertedUnits: 0,
        resolvedUnits: 0,
      };
    }

    const semanticReplay = this.replaySemanticEventsFromTape(input.sessionId, input.events);
    const projectionReplay = this.replayProjectionEventsFromTape(input.sessionId, input.events);

    const replayedEvents = semanticReplay.replayedEvents + projectionReplay.replayedEvents;
    const upsertedUnits = semanticReplay.upsertedUnits + projectionReplay.importedUnits;
    const resolvedUnits = semanticReplay.resolvedUnits;
    const rebuilt =
      semanticReplay.rebuilt ||
      projectionReplay.importedUnits > 0 ||
      projectionReplay.importedCrystals > 0 ||
      projectionReplay.importedInsights > 0 ||
      projectionReplay.importedEdges > 0 ||
      projectionReplay.importedWorking > 0;
    return {
      rebuilt,
      reason: rebuilt ? "replayed" : "no_replayable_events",
      scannedEvents: input.events.length,
      replayedEvents,
      upsertedUnits,
      resolvedUnits,
    };
  }

  private replaySemanticEventsFromTape(
    sessionId: string,
    events: BrewvaEventRecord[],
  ): {
    rebuilt: boolean;
    replayedEvents: number;
    upsertedUnits: number;
    resolvedUnits: number;
  } {
    const store = this.getStore();
    let replayedEvents = 0;
    let upsertedUnits = 0;
    let resolvedUnits = 0;
    const dirtyTopicsFromUnits: string[] = [];
    const dirtyTopicsFromResolves: string[] = [];

    for (const event of events) {
      if (!event || event.sessionId !== sessionId) continue;
      if (event.type.startsWith("memory_")) continue;
      const extraction = extractMemoryFromEvent(event);
      if (extraction.upserts.length === 0 && extraction.resolves.length === 0) {
        continue;
      }
      replayedEvents += 1;

      for (const candidate of extraction.upserts) {
        const result = store.upsertUnit(candidate);
        upsertedUnits += 1;
        const taskKind =
          typeof result.unit.metadata?.taskKind === "string" ? result.unit.metadata.taskKind : null;
        const memorySignal =
          typeof result.unit.metadata?.memorySignal === "string"
            ? result.unit.metadata.memorySignal
            : null;
        if (taskKind !== "status_set" || memorySignal === "verification") {
          dirtyTopicsFromUnits.push(result.unit.topic);
        }
      }

      for (const directive of extraction.resolves) {
        const resolvedCount = store.resolveUnits(directive);
        resolvedUnits += resolvedCount;
        if (resolvedCount > 0) {
          dirtyTopicsFromResolves.push(`${directive.sourceType}:${directive.sourceId}`);
        }
      }
    }

    if (dirtyTopicsFromUnits.length > 0) {
      store.mergeDirtyTopics(dirtyTopicsFromUnits, { reason: "replay_new_unit" });
    }
    if (dirtyTopicsFromResolves.length > 0) {
      store.mergeDirtyTopics(dirtyTopicsFromResolves, { reason: "replay_resolve_directive" });
    }

    return {
      rebuilt: replayedEvents > 0 || upsertedUnits > 0 || resolvedUnits > 0,
      replayedEvents,
      upsertedUnits,
      resolvedUnits,
    };
  }

  private replayProjectionEventsFromTape(
    sessionId: string,
    events: BrewvaEventRecord[],
  ): {
    replayedEvents: number;
    importedUnits: number;
    importedCrystals: number;
    importedInsights: number;
    importedEdges: number;
    importedWorking: number;
  } {
    const store = this.getStore();
    let replayedEvents = 0;
    let importedUnits = 0;
    let importedCrystals = 0;
    let importedInsights = 0;
    let importedEdges = 0;
    let importedWorking = 0;

    for (const event of events) {
      if (!event || event.sessionId !== sessionId) continue;
      if (!event.type.startsWith("memory_")) continue;
      if (!isRecord(event.payload)) continue;
      const payload = event.payload;

      if (isRecord(payload.unit)) {
        const imported = store.importUnitSnapshot(payload.unit as unknown as MemoryUnit);
        if (imported.applied) {
          importedUnits += 1;
          replayedEvents += 1;
        }
      }

      if (isRecord(payload.crystal)) {
        const imported = store.importCrystalSnapshot(payload.crystal as unknown as MemoryCrystal);
        if (imported.applied) {
          importedCrystals += 1;
          replayedEvents += 1;
        }
      }

      if (isRecord(payload.insight)) {
        const imported = store.importInsightSnapshot(payload.insight as unknown as MemoryInsight);
        if (imported.applied) {
          importedInsights += 1;
          replayedEvents += 1;
        }
      }

      if (isRecord(payload.edge)) {
        const imported = store.importEvolvesEdgeSnapshot(
          payload.edge as unknown as MemoryEvolvesEdge,
        );
        if (imported.applied) {
          importedEdges += 1;
          replayedEvents += 1;
        }
      }

      if (event.type === "memory_working_published" && isRecord(payload.working)) {
        const generatedAt =
          typeof payload.generatedAt === "number" && Number.isFinite(payload.generatedAt)
            ? payload.generatedAt
            : typeof payload.working.generatedAt === "number" &&
                Number.isFinite(payload.working.generatedAt)
              ? payload.working.generatedAt
              : Date.now();
        const working = payload.working as unknown as WorkingMemorySnapshot;
        store.importWorkingSnapshot(working, this.maxWorkingChars);
        store.markPublished({
          at: generatedAt,
          dayKey: toDayKey(new Date(generatedAt)),
        });
        importedWorking += 1;
        replayedEvents += 1;
      }

      if (event.type === "memory_global_sync") {
        const snapshotRef =
          typeof payload.globalSnapshotRef === "string" ? payload.globalSnapshotRef : "";
        if (!snapshotRef) continue;
        const tier = this.getGlobalTier();
        if (!tier) continue;
        const snapshot = this.loadGlobalSyncSnapshot(snapshotRef);
        if (!snapshot) continue;
        const imported = tier.importSnapshot(snapshot);
        if (
          imported.importedUnits > 0 ||
          imported.importedCrystals > 0 ||
          imported.removedUnits > 0 ||
          imported.removedCrystals > 0
        ) {
          replayedEvents += 1;
        }
      }
    }

    return {
      replayedEvents,
      importedUnits,
      importedCrystals,
      importedInsights,
      importedEdges,
      importedWorking,
    };
  }

  private collectInsights(sessionId: string, units: ReturnType<MemoryStore["listUnits"]>) {
    const store = this.getStore();
    const existing = store.listInsights(sessionId);
    const existingByMessage = new Set(existing.map((insight) => insight.message));
    const activeByTopic = new Map<string, Set<string>>();
    for (const unit of units) {
      if (unit.sessionId !== sessionId || unit.status !== "active") continue;
      const key = unit.topic.trim().toLowerCase();
      const statements = activeByTopic.get(key) ?? new Set<string>();
      statements.add(unit.statement.trim().toLowerCase());
      activeByTopic.set(key, statements);
    }

    for (const [topic, statements] of activeByTopic.entries()) {
      if (statements.size < 2) continue;
      const message = `Potential conflict in topic '${topic}' with ${statements.size} active statements.`;
      if (existingByMessage.has(message)) continue;
      const related = units
        .filter((unit) => unit.status === "active" && unit.topic.trim().toLowerCase() === topic)
        .slice(0, 8)
        .map((unit) => unit.id);
      const insight = store.addInsight({
        sessionId,
        kind: "conflict",
        status: "open",
        message,
        relatedUnitIds: related,
      });
      existingByMessage.add(message);
      this.recordEvent?.({
        sessionId,
        type: "memory_insight_recorded",
        payload: {
          insightId: insight.id,
          kind: insight.kind,
          message: insight.message,
          relatedUnitIds: insight.relatedUnitIds,
          insight: insight as unknown as Record<string, unknown>,
        },
      });
    }

    return store.listInsights(sessionId);
  }

  private shouldRunCognitiveRelationInference(): boolean {
    return (
      this.cognitiveMode !== "off" &&
      this.cognitiveMaxInferenceCallsPerRefresh > 0 &&
      typeof this.cognitivePort?.inferRelation === "function"
    );
  }

  private resolveCognitiveBudgetStatus(sessionId: string): CognitiveTokenBudgetStatus | null {
    if (!this.getCognitiveBudgetStatus) return null;
    try {
      return this.getCognitiveBudgetStatus(sessionId);
    } catch {
      return null;
    }
  }

  private recordCognitiveUsageWithBudget(input: {
    sessionId: string;
    stage: string;
    usage: CognitiveUsage | null;
  }): CognitiveTokenBudgetStatus | null {
    if (!this.recordCognitiveUsage) return this.resolveCognitiveBudgetStatus(input.sessionId);
    const effectiveUsage: CognitiveUsage = input.usage ?? { totalTokens: 0 };
    try {
      return this.recordCognitiveUsage({
        sessionId: input.sessionId,
        stage: input.stage,
        usage: effectiveUsage,
      });
    } catch {
      return this.resolveCognitiveBudgetStatus(input.sessionId);
    }
  }

  private shouldRunCognitiveRanking(): boolean {
    return (
      this.cognitiveMode !== "off" &&
      this.cognitiveMaxRankCandidatesPerSearch > 1 &&
      typeof this.cognitivePort?.rankRelevance === "function"
    );
  }

  private async maybeRecordCognitiveRelevanceRanking(input: {
    sessionId: string;
    query: string;
    result: MemorySearchResult;
    allowAsyncApply: boolean;
  }): Promise<void> {
    if (!this.shouldRunCognitiveRanking()) return;
    if (input.result.hits.length <= 1) return;
    const cognitivePort = this.cognitivePort;
    if (!cognitivePort?.rankRelevance) return;

    const candidates = input.result.hits
      .slice(0, this.cognitiveMaxRankCandidatesPerSearch)
      .map((hit) => ({
        id: hit.id,
        statement: `${hit.topic}\n${hit.excerpt}`,
      }));
    if (candidates.length <= 1) return;
    const tokenBudgetBefore = this.resolveCognitiveBudgetStatus(input.sessionId);
    if ((tokenBudgetBefore?.maxTokensPerTurn ?? 1) <= 0) {
      return;
    }
    if (tokenBudgetBefore?.exhausted) {
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "cognitive_relevance_ranking_skipped",
        payload: {
          stage: "memory_recall_ranking",
          mode: this.cognitiveMode,
          reason: "token_budget_exhausted",
          query: input.query.trim(),
          candidateCount: candidates.length,
          budget: cognitiveBudgetPayload(tokenBudgetBefore),
        },
      });
      return;
    }

    const deterministicTopIds = candidates.map((candidate) => candidate.id);
    const deterministicPositionById = new Map<string, number>(
      deterministicTopIds.map((id, index) => [id, index]),
    );

    const commit = (inputCommit: {
      output: Array<{ id: string; score: number }>;
      usage: CognitiveUsage | null;
      applyRanking: boolean;
      asyncResult: boolean;
      skippedReason?: string;
    }) => {
      const scoreById = new Map<string, number>();
      for (const item of inputCommit.output ?? []) {
        if (!item || typeof item.id !== "string") continue;
        if (!deterministicPositionById.has(item.id)) continue;
        scoreById.set(item.id, sanitizeRankScore(item.score));
      }
      const inferredTopIds = deterministicTopIds.toSorted((left, right) => {
        const leftScore = scoreById.get(left) ?? 0;
        const rightScore = scoreById.get(right) ?? 0;
        if (rightScore !== leftScore) return rightScore - leftScore;
        return (
          (deterministicPositionById.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (deterministicPositionById.get(right) ?? Number.MAX_SAFE_INTEGER)
        );
      });
      const changedPositions = inferredTopIds.filter(
        (id, index) => id !== deterministicTopIds[index],
      ).length;
      const budgetAfter = this.recordCognitiveUsageWithBudget({
        sessionId: input.sessionId,
        stage: "memory_recall_ranking",
        usage: inputCommit.usage,
      });
      const appliedRanking = inputCommit.applyRanking && changedPositions > 0;
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "cognitive_relevance_ranking",
        payload: {
          stage: "memory_recall_ranking",
          mode: this.cognitiveMode,
          query: input.query.trim(),
          candidateCount: candidates.length,
          asyncResult: inputCommit.asyncResult,
          deterministicTopIds,
          inferredTopIds,
          changedPositions,
          appliedRanking,
          skippedReason: inputCommit.skippedReason ?? null,
          usage: cognitiveUsagePayload(inputCommit.usage),
          budget: cognitiveBudgetPayload(budgetAfter),
          scores: inferredTopIds.map((id) => ({
            id,
            score: scoreById.get(id) ?? 0,
          })),
        },
      });
      if (appliedRanking) {
        const hitById = new Map(input.result.hits.map((hit) => [hit.id, hit]));
        const reordered = inferredTopIds
          .map((id) => hitById.get(id))
          .filter((hit): hit is NonNullable<typeof hit> => hit != null);
        const remainingHits = input.result.hits.filter(
          (hit) => !deterministicPositionById.has(hit.id),
        );
        input.result.hits = [...reordered, ...remainingHits];
      }
    };

    const fail = (error: unknown) => {
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "cognitive_relevance_ranking_failed",
        payload: {
          stage: "memory_recall_ranking",
          mode: this.cognitiveMode,
          query: input.query.trim(),
          candidateCount: candidates.length,
          budget: cognitiveBudgetPayload(this.resolveCognitiveBudgetStatus(input.sessionId)),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    };

    try {
      const ranking = cognitivePort.rankRelevance({
        query: input.query,
        candidates,
      });
      if (isPromiseLike(ranking)) {
        if (input.allowAsyncApply) {
          const resolved = await ranking;
          const normalized = normalizeCognitiveRankResult(resolved);
          commit({
            output: normalized.scores,
            usage: normalized.usage,
            applyRanking: this.cognitiveMode === "active",
            asyncResult: true,
          });
          return;
        }
        const skippedReason =
          this.cognitiveMode === "active"
            ? "async_result_not_applicable_to_sync_search"
            : undefined;
        if (skippedReason) {
          this.recordEvent?.({
            sessionId: input.sessionId,
            type: "cognitive_relevance_ranking_skipped",
            payload: {
              stage: "memory_recall_ranking",
              mode: this.cognitiveMode,
              reason: skippedReason,
              query: input.query.trim(),
              candidateCount: candidates.length,
              budget: cognitiveBudgetPayload(tokenBudgetBefore),
            },
          });
        }
        void ranking
          .then((resolved) => {
            const normalized = normalizeCognitiveRankResult(resolved);
            commit({
              output: normalized.scores,
              usage: normalized.usage,
              applyRanking: false,
              asyncResult: true,
              skippedReason,
            });
          })
          .catch(fail);
        return;
      }
      const normalized = normalizeCognitiveRankResult(ranking);
      commit({
        output: normalized.scores,
        usage: normalized.usage,
        applyRanking: this.cognitiveMode === "active",
        asyncResult: false,
      });
    } catch (error) {
      fail(error);
    }
  }

  private maybeRecordCognitiveRelationInference(input: {
    sessionId: string;
    edgeId: string;
    topic: string;
    newer: string;
    older: string;
    sourceUnitId: string;
    targetUnitId: string;
    deterministicRelation: MemoryEvolvesEdge["relation"];
    budget: { remaining: number; exhaustedNoted: boolean };
  }): void {
    if (!this.shouldRunCognitiveRelationInference()) return;
    const cognitivePort = this.cognitivePort;
    if (!cognitivePort?.inferRelation) return;
    const tokenBudgetBefore = this.resolveCognitiveBudgetStatus(input.sessionId);
    if ((tokenBudgetBefore?.maxTokensPerTurn ?? 1) <= 0) {
      return;
    }
    if (tokenBudgetBefore?.exhausted) {
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "cognitive_relation_inference_skipped",
        payload: {
          stage: "memory_evolves_relation",
          reason: "token_budget_exhausted",
          edgeId: input.edgeId,
          maxInferenceCallsPerRefresh: this.cognitiveMaxInferenceCallsPerRefresh,
          budget: cognitiveBudgetPayload(tokenBudgetBefore),
        },
      });
      return;
    }

    if (input.budget.remaining <= 0) {
      if (!input.budget.exhaustedNoted) {
        input.budget.exhaustedNoted = true;
        this.recordEvent?.({
          sessionId: input.sessionId,
          type: "cognitive_relation_inference_skipped",
          payload: {
            stage: "memory_evolves_relation",
            reason: "budget_exhausted",
            edgeId: input.edgeId,
            maxInferenceCallsPerRefresh: this.cognitiveMaxInferenceCallsPerRefresh,
            budget: cognitiveBudgetPayload(tokenBudgetBefore),
          },
        });
      }
      return;
    }
    input.budget.remaining -= 1;

    const commit = (output: CognitiveInferRelationOutput) => {
      const inferred = output?.relation;
      const relation: MemoryEvolvesEdge["relation"] =
        inferred === "replaces" ||
        inferred === "enriches" ||
        inferred === "confirms" ||
        inferred === "challenges"
          ? inferred
          : input.deterministicRelation;
      const usage = normalizeCognitiveUsage(output?.usage);
      const tokenBudgetAfter = this.recordCognitiveUsageWithBudget({
        sessionId: input.sessionId,
        stage: "memory_evolves_relation",
        usage,
      });
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "cognitive_relation_inference",
        payload: {
          stage: "memory_evolves_relation",
          mode: this.cognitiveMode,
          edgeId: input.edgeId,
          topic: input.topic,
          sourceUnitId: input.sourceUnitId,
          targetUnitId: input.targetUnitId,
          deterministicRelation: input.deterministicRelation,
          inferredRelation: relation,
          confidence: clampProbability(output?.confidence, 0.5),
          rationale: sanitizeRationale(output?.rationale),
          usage: cognitiveUsagePayload(usage),
          budget: cognitiveBudgetPayload(tokenBudgetAfter),
        },
      });
      if (this.cognitiveMode === "active") {
        const store = this.getStore();
        if (relation !== input.deterministicRelation) {
          store.updateEvolvesEdgeRelation({
            edgeId: input.edgeId,
            relation,
            confidence: clampProbability(output?.confidence, 0.5),
            rationale: sanitizeRationale(output?.rationale) ?? undefined,
          });
        }
        const effectiveEdge = store
          .listEvolvesEdges(input.sessionId)
          .find((candidate) => candidate.id === input.edgeId);
        if (effectiveEdge) {
          this.syncEvolvesPendingInsight({
            sessionId: input.sessionId,
            edge: effectiveEdge,
            topic: input.topic,
            sourceUnitId: input.sourceUnitId,
            targetUnitId: input.targetUnitId,
          });
        }
      }
    };

    const fail = (error: unknown) => {
      this.recordEvent?.({
        sessionId: input.sessionId,
        type: "cognitive_relation_inference_failed",
        payload: {
          stage: "memory_evolves_relation",
          mode: this.cognitiveMode,
          edgeId: input.edgeId,
          topic: input.topic,
          sourceUnitId: input.sourceUnitId,
          targetUnitId: input.targetUnitId,
          deterministicRelation: input.deterministicRelation,
          budget: cognitiveBudgetPayload(this.resolveCognitiveBudgetStatus(input.sessionId)),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    };

    try {
      const result = cognitivePort.inferRelation({
        newer: input.newer,
        older: input.older,
        topic: input.topic,
      });
      if (isPromiseLike<CognitiveInferRelationOutput>(result)) {
        void result.then(commit).catch(fail);
        return;
      }
      commit(result);
    } catch (error) {
      fail(error);
    }
  }

  private syncEvolvesPendingInsight(input: {
    sessionId: string;
    edge: MemoryEvolvesEdge;
    topic: string;
    sourceUnitId: string;
    targetUnitId: string;
  }): void {
    const store = this.getStore();
    const openInsight = store.listInsights(input.sessionId).find((insight) => {
      if (insight.status !== "open") return false;
      if (insight.kind !== "evolves_pending") return false;
      return insight.edgeId === input.edge.id;
    });
    const shouldBePending =
      input.edge.relation === "replaces" || input.edge.relation === "challenges";
    if (!shouldBePending) {
      if (openInsight) {
        this.dismissInsight(input.sessionId, openInsight.id);
      }
      return;
    }

    const relatedUnitIds = [input.sourceUnitId, input.targetUnitId];
    const message = `Pending evolves: edge=${input.edge.id} topic='${input.topic}' relation=${input.edge.relation} (${input.sourceUnitId} -> ${input.targetUnitId}).`;
    const isSameOpenInsight =
      openInsight &&
      openInsight.relation === input.edge.relation &&
      openInsight.message === message &&
      openInsight.relatedUnitIds.length === relatedUnitIds.length &&
      openInsight.relatedUnitIds.every((id, index) => id === relatedUnitIds[index]);
    if (isSameOpenInsight) return;

    if (openInsight) {
      this.dismissInsight(input.sessionId, openInsight.id);
    }
    const insight = store.addInsight({
      sessionId: input.sessionId,
      kind: "evolves_pending",
      status: "open",
      edgeId: input.edge.id,
      relation: input.edge.relation,
      message,
      relatedUnitIds,
    });
    this.recordEvent?.({
      sessionId: input.sessionId,
      type: "memory_insight_recorded",
      payload: {
        insightId: insight.id,
        kind: insight.kind,
        edgeId: input.edge.id,
        relation: input.edge.relation,
        message: insight.message,
        relatedUnitIds: insight.relatedUnitIds,
        insight: insight as unknown as Record<string, unknown>,
        edge: input.edge as unknown as Record<string, unknown>,
      },
    });
  }

  private maybeCreateEvolvesEdges(
    sessionId: string,
    units: ReturnType<MemoryStore["listUnits"]>,
  ): void {
    const store = this.getStore();
    const active = units
      .filter((unit) => unit.sessionId === sessionId && unit.status === "active")
      .toSorted((left, right) => right.updatedAt - left.updatedAt);
    const byTopic = new Map<string, typeof active>();
    for (const unit of active) {
      const key = unit.topic.trim().toLowerCase();
      const bucket = byTopic.get(key) ?? [];
      bucket.push(unit);
      byTopic.set(key, bucket);
    }

    const existingEdges = store.listEvolvesEdges(sessionId);
    const existingKeys = new Set(
      existingEdges.map((edge) => `${edge.sourceUnitId}:${edge.targetUnitId}`),
    );
    const cognitiveBudget = {
      remaining: this.cognitiveMaxInferenceCallsPerRefresh,
      exhaustedNoted: false,
    };
    for (const topicUnits of byTopic.values()) {
      const limited = topicUnits.slice(0, 4);
      for (let index = 0; index + 1 < limited.length; index += 1) {
        const newer = limited[index];
        const older = limited[index + 1];
        if (!newer || !older) continue;
        const relation = inferEvolvesRelation({
          newerFingerprint: newer.fingerprint,
          olderFingerprint: older.fingerprint,
          newer: newer.statement,
          older: older.statement,
        });
        const key = `${newer.id}:${older.id}`;
        if (existingKeys.has(key)) continue;
        const edge = store.addEvolvesEdge({
          sessionId,
          sourceUnitId: newer.id,
          targetUnitId: older.id,
          relation,
          status: "proposed",
          confidence: 0.58,
          rationale: `shadow relation inferred from topic=${newer.topic}`,
        });
        existingKeys.add(key);
        this.maybeRecordCognitiveRelationInference({
          sessionId,
          edgeId: edge.id,
          topic: newer.topic,
          newer: newer.statement,
          older: older.statement,
          sourceUnitId: newer.id,
          targetUnitId: older.id,
          deterministicRelation: relation,
          budget: cognitiveBudget,
        });
        const effectiveEdge = store
          .listEvolvesEdges(sessionId)
          .find((candidate) => candidate.id === edge.id);
        this.syncEvolvesPendingInsight({
          sessionId,
          edge: effectiveEdge ?? edge,
          topic: newer.topic,
          sourceUnitId: newer.id,
          targetUnitId: older.id,
        });
      }
    }
  }

  private persistGlobalSyncSnapshot(snapshot: GlobalMemorySnapshot): string | null {
    const fileName = `snapshot-${snapshot.generatedAt}-${Math.random().toString(36).slice(2, 10)}.json`;
    const snapshotRef = join(GLOBAL_SYNC_SNAPSHOT_DIR, fileName);
    const snapshotPath = resolve(this.rootDir, snapshotRef);
    try {
      writeFileAtomic(snapshotPath, JSON.stringify(snapshot));
      return snapshotRef.replaceAll("\\", "/");
    } catch {
      return null;
    }
  }

  private resolveGlobalSyncSnapshotPath(snapshotRef: string): string | null {
    const normalizedRef = snapshotRef.trim();
    if (!normalizedRef) return null;
    const snapshotPath = isAbsolute(normalizedRef)
      ? resolve(normalizedRef)
      : resolve(this.rootDir, normalizedRef);
    const relativePath = relative(this.rootDir, snapshotPath);
    if (!relativePath || relativePath === ".") return null;
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
    return snapshotPath;
  }

  private loadGlobalSyncSnapshot(snapshotRef: string): GlobalMemorySnapshot | null {
    const snapshotPath = this.resolveGlobalSyncSnapshotPath(snapshotRef);
    if (!snapshotPath) return null;

    try {
      const raw = readFileSync(snapshotPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) return null;
      return parsed as unknown as GlobalMemorySnapshot;
    } catch {
      return null;
    }
  }

  private getGlobalTier(): GlobalMemoryTier | null {
    if (!this.globalEnabled) return null;
    if (!this.globalTier) {
      this.globalTier = new GlobalMemoryTier({
        rootDir: join(this.rootDir, "global"),
        promotionMinConfidence: this.globalMinConfidence,
        promotionMinSessionRecurrence: this.globalMinSessionRecurrence,
        decayIntervalDays: this.globalDecayIntervalDays,
        decayFactor: this.globalDecayFactor,
        pruneBelowConfidence: this.globalPruneBelowConfidence,
      });
    }
    return this.globalTier;
  }

  private getStore(): MemoryStore {
    if (!this.store) {
      this.store = new MemoryStore({
        rootDir: this.rootDir,
        workingFile: this.workingFile,
      });
    }
    return this.store;
  }
}
