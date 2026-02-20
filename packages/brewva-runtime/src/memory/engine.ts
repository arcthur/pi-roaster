import type { BrewvaEventRecord } from "../types.js";
import { compileCrystalDrafts } from "./crystal.js";
import { extractMemoryFromEvent } from "./extractor.js";
import { searchMemory, type MemoryRetrievalWeights } from "./retrieval.js";
import { MemoryStore } from "./store.js";
import type { MemoryEvolvesEdge, MemorySearchResult, WorkingMemorySnapshot } from "./types.js";
import { buildWorkingMemorySnapshot } from "./working-memory.js";

function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  recordEvent?: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }) => void;
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
  private readonly recordEvent?: MemoryEngineOptions["recordEvent"];
  private store: MemoryStore | null = null;

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
    const dirtyTopics: string[] = [];
    for (const candidate of extraction.upserts) {
      const result = store.upsertUnit(candidate);
      const taskKind =
        typeof result.unit.metadata?.taskKind === "string" ? result.unit.metadata.taskKind : null;
      const memorySignal =
        typeof result.unit.metadata?.memorySignal === "string"
          ? result.unit.metadata.memorySignal
          : null;
      if (taskKind !== "status_set" || memorySignal === "verification") {
        dirtyTopics.push(result.unit.topic);
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
        },
      });
    }
    for (const directive of extraction.resolves) {
      const resolvedCount = store.resolveUnits(directive);
      if (resolvedCount > 0) {
        dirtyTopics.push(`${directive.sourceType}:${directive.sourceId}`);
      }
    }
    if (dirtyTopics.length > 0) {
      store.mergeDirtyTopics(dirtyTopics);
    }
  }

  refreshIfNeeded(input: { sessionId: string }): WorkingMemorySnapshot | undefined {
    if (!this.enabled) return undefined;
    const now = new Date();
    const store = this.getStore();
    const state = store.getState();
    const today = toDayKey(now);
    const crossedDailyHour = now.getHours() >= this.dailyRefreshHourLocal;
    const needsDailyRefresh = crossedDailyHour && state.lastPublishedDayKey !== today;
    const needsEventRefresh = state.dirtyTopics.length > 0;
    const needsRefresh = needsDailyRefresh || needsEventRefresh;

    if (!needsRefresh) {
      const cached = store.getWorkingSnapshot(input.sessionId);
      if (cached) return cached;
    }

    const refreshResult = store.withRefreshLock(() => {
      const rechecked = store.getState();
      const stillNeedsDailyRefresh = crossedDailyHour && rechecked.lastPublishedDayKey !== today;
      const stillNeedsEventRefresh = rechecked.dirtyTopics.length > 0;
      if (!stillNeedsDailyRefresh && !stillNeedsEventRefresh) {
        return store.getWorkingSnapshot(input.sessionId);
      }

      const units = store.listUnits(input.sessionId);
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

  search(sessionId: string, input: { query: string; limit?: number }): MemorySearchResult {
    if (!this.enabled) {
      return {
        sessionId,
        query: input.query,
        scanned: 0,
        hits: [],
      };
    }
    const store = this.getStore();
    return searchMemory({
      sessionId,
      query: input.query,
      units: store.listUnits(sessionId),
      crystals: store.listCrystals(sessionId),
      limit: Math.max(1, input.limit ?? this.retrievalTopK),
      weights: this.retrievalWeights,
    });
  }

  buildRecallBlock(input: { sessionId: string; query: string; limit?: number }): string {
    const result = this.search(input.sessionId, {
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
    });
    return lines.join("\n");
  }

  dismissInsight(sessionId: string, insightId: string): boolean {
    if (!this.enabled) return false;
    const dismissed = this.getStore().dismissInsight(insightId);
    if (dismissed) {
      this.recordEvent?.({
        sessionId,
        type: "memory_insight_dismissed",
        payload: { insightId },
      });
    }
    return dismissed;
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

    store.mergeDirtyTopics([`evolves_edge_reviewed:${result.edge.id}`]);
    return { ok: true };
  }

  clearSessionCache(sessionId: string): void {
    this.store?.clearSessionCache(sessionId);
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
        },
      });
    }

    return store.listInsights(sessionId);
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

        if (relation !== "replaces" && relation !== "challenges") continue;
        const message = `Pending evolves: edge=${edge.id} topic='${newer.topic}' relation=${relation} (${newer.id} -> ${older.id}).`;
        const insight = store.addInsight({
          sessionId,
          kind: "evolves_pending",
          status: "open",
          edgeId: edge.id,
          relation: edge.relation,
          message,
          relatedUnitIds: [newer.id, older.id],
        });
        this.recordEvent?.({
          sessionId,
          type: "memory_insight_recorded",
          payload: {
            insightId: insight.id,
            kind: insight.kind,
            edgeId: edge.id,
            relation: edge.relation,
            message: insight.message,
            relatedUnitIds: insight.relatedUnitIds,
          },
        });
      }
    }
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
