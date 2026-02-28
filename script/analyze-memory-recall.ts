#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface EventRecord {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

interface MemoryUnitRow {
  id: string;
  status?: string;
  topic?: string;
  statement?: string;
  updatedAt?: number;
}

interface MemoryCrystalRow {
  id: string;
  topic?: string;
  summary?: string;
  updatedAt?: number;
}

interface IndexedMemoryRow {
  id: string;
  text: string;
  status: string | null;
  updatedAt: number;
}

interface AnalyzerOptions {
  eventsDir: string;
  memoryDir: string;
  topK: number;
  minShadowSamples: number;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  return matches.map((token) => token.trim()).filter((token) => token.length > 0);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function parseArgs(argv: string[]): AnalyzerOptions {
  const options: AnalyzerOptions = {
    eventsDir: ".orchestrator/events",
    memoryDir: ".orchestrator/memory",
    topK: 3,
    minShadowSamples: 40,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--events-dir" && typeof next === "string") {
      options.eventsDir = next;
      index += 1;
      continue;
    }
    if (arg === "--memory-dir" && typeof next === "string") {
      options.memoryDir = next;
      index += 1;
      continue;
    }
    if (arg === "--top-k" && typeof next === "string") {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.topK = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
    if (arg === "--min-shadow-samples" && typeof next === "string") {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.minShadowSamples = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
  }
  return options;
}

function parseJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const rows: unknown[] = [];
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function normalizeEvent(value: unknown): EventRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<EventRecord>;
  const id = toNonEmptyString(row.id);
  const sessionId = toNonEmptyString(row.sessionId);
  const type = toNonEmptyString(row.type);
  const timestamp = toFiniteNumber(row.timestamp);
  if (!id || !sessionId || !type || timestamp === null) return null;
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload
      : undefined;
  return {
    id,
    sessionId,
    type,
    timestamp,
    payload,
  };
}

function collectEvents(eventsDir: string): EventRecord[] {
  if (!existsSync(eventsDir)) return [];
  const files = readdirSync(eventsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(eventsDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
  const events: EventRecord[] = [];
  for (const file of files) {
    const rows = parseJsonLines(file);
    for (const raw of rows) {
      const event = normalizeEvent(raw);
      if (!event) continue;
      events.push(event);
    }
  }
  return events.toSorted((left, right) => left.timestamp - right.timestamp);
}

function listMemoryPaths(memoryDir: string): {
  units: string[];
  crystals: string[];
} {
  return {
    units: [join(memoryDir, "units.jsonl"), join(memoryDir, "global", "units.jsonl")],
    crystals: [join(memoryDir, "crystals.jsonl"), join(memoryDir, "global", "crystals.jsonl")],
  };
}

function loadMemoryIndex(memoryDir: string): Map<string, IndexedMemoryRow> {
  const paths = listMemoryPaths(memoryDir);
  const indexedById = new Map<string, IndexedMemoryRow>();

  for (const unitsPath of paths.units) {
    for (const raw of parseJsonLines(unitsPath)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Partial<MemoryUnitRow>;
      const id = toNonEmptyString(row.id);
      if (!id) continue;
      const topic = toNonEmptyString(row.topic) ?? "";
      const statement = toNonEmptyString(row.statement) ?? "";
      const updatedAt = toFiniteNumber(row.updatedAt) ?? 0;
      const next: IndexedMemoryRow = {
        id,
        text: `${topic}\n${statement}`.trim(),
        status: toNonEmptyString(row.status),
        updatedAt,
      };
      const existing = indexedById.get(id);
      if (!existing || next.updatedAt >= existing.updatedAt) {
        indexedById.set(id, next);
      }
    }
  }

  for (const crystalsPath of paths.crystals) {
    for (const raw of parseJsonLines(crystalsPath)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Partial<MemoryCrystalRow>;
      const id = toNonEmptyString(row.id);
      if (!id) continue;
      const topic = toNonEmptyString(row.topic) ?? "";
      const summary = toNonEmptyString(row.summary) ?? "";
      const updatedAt = toFiniteNumber(row.updatedAt) ?? 0;
      const next: IndexedMemoryRow = {
        id,
        text: `${topic}\n${summary}`.trim(),
        status: null,
        updatedAt,
      };
      const existing = indexedById.get(id);
      if (!existing || next.updatedAt >= existing.updatedAt) {
        indexedById.set(id, next);
      }
    }
  }
  return indexedById;
}

function lexicalOverlap(query: string, candidateText: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const candidateTokens = new Set(tokenize(candidateText));
  if (candidateTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, queryTokens.size);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizedKendallDistance(orderA: string[], orderB: string[]): number {
  const shared = orderA.filter((id) => orderB.includes(id));
  if (shared.length <= 1) return 0;
  const positionA = new Map<string, number>(shared.map((id, index) => [id, index]));
  const positionB = new Map<string, number>(
    orderB.filter((id) => positionA.has(id)).map((id, index) => [id, index]),
  );
  let inversions = 0;
  let totalPairs = 0;
  for (let left = 0; left < shared.length; left += 1) {
    for (let right = left + 1; right < shared.length; right += 1) {
      const leftId = shared[left];
      const rightId = shared[right];
      if (!leftId || !rightId) continue;
      const a = positionA.get(leftId) ?? 0;
      const b = positionA.get(rightId) ?? 0;
      const c = positionB.get(leftId) ?? 0;
      const d = positionB.get(rightId) ?? 0;
      totalPairs += 1;
      if ((a - b) * (c - d) < 0) {
        inversions += 1;
      }
    }
  }
  if (totalPairs <= 0) return 0;
  return inversions / totalPairs;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function collectReferencedUnitIds(event: EventRecord): string[] {
  const payload = event.payload;
  if (!payload) return [];
  const ids: string[] = [];
  if (event.type === "memory_evolves_edge_reviewed") {
    const source = toNonEmptyString(payload.sourceUnitId);
    const target = toNonEmptyString(payload.targetUnitId);
    if (source) ids.push(source);
    if (target) ids.push(target);
  }
  if (event.type === "memory_unit_superseded") {
    const unitId = toNonEmptyString(payload.unitId);
    const supersededBy = toNonEmptyString(payload.supersededByUnitId);
    if (unitId) ids.push(unitId);
    if (supersededBy) ids.push(supersededBy);
  }
  if (event.type === "memory_insight_recorded") {
    const relatedUnitIds = payload.relatedUnitIds;
    if (Array.isArray(relatedUnitIds)) {
      for (const id of relatedUnitIds) {
        const normalized = toNonEmptyString(id);
        if (normalized) ids.push(normalized);
      }
    }
  }
  return ids;
}

function computeDownstreamHitAtK(
  events: EventRecord[],
  topK: number,
): {
  deterministicDownstreamHitAtK: number[];
  inferredDownstreamHitAtK: number[];
  downstreamReferencedIdsCount: number;
} {
  const deterministicDownstreamHitAtK = Array.from({ length: topK }, () => 0);
  const inferredDownstreamHitAtK = Array.from({ length: topK }, () => 0);
  const referencedGlobal = new Set<string>();
  const futureReferencedBySession = new Map<string, Set<string>>();

  const ensureFutureSet = (sessionId: string): Set<string> => {
    const existing = futureReferencedBySession.get(sessionId);
    if (existing) return existing;
    const created = new Set<string>();
    futureReferencedBySession.set(sessionId, created);
    return created;
  };

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const ids = collectReferencedUnitIds(event);
    if (ids.length > 0) {
      const future = ensureFutureSet(event.sessionId);
      for (const id of ids) {
        future.add(id);
        referencedGlobal.add(id);
      }
    }

    if (event.type !== "cognitive_relevance_ranking") continue;
    const payload = event.payload ?? {};
    const query = toNonEmptyString(payload.query) ?? "";
    const deterministicTopIds = parseStringArray(payload.deterministicTopIds);
    const inferredTopIds = parseStringArray(payload.inferredTopIds);
    if (deterministicTopIds.length === 0 || inferredTopIds.length === 0 || !query) {
      continue;
    }
    const futureReferenced = futureReferencedBySession.get(event.sessionId) ?? new Set<string>();
    for (let offset = 0; offset < topK; offset += 1) {
      const windowSize = offset + 1;
      const deterministicWindow = deterministicTopIds.slice(0, windowSize);
      const inferredWindow = inferredTopIds.slice(0, windowSize);
      if (deterministicWindow.some((id) => futureReferenced.has(id))) {
        deterministicDownstreamHitAtK[offset] = (deterministicDownstreamHitAtK[offset] ?? 0) + 1;
      }
      if (inferredWindow.some((id) => futureReferenced.has(id))) {
        inferredDownstreamHitAtK[offset] = (inferredDownstreamHitAtK[offset] ?? 0) + 1;
      }
    }
  }

  return {
    deterministicDownstreamHitAtK,
    inferredDownstreamHitAtK,
    downstreamReferencedIdsCount: referencedGlobal.size,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const eventsDir = resolve(process.cwd(), options.eventsDir);
  const memoryDir = resolve(process.cwd(), options.memoryDir);

  const events = collectEvents(eventsDir);
  const memoryIndex = loadMemoryIndex(memoryDir);
  const topK = Math.max(1, options.topK);
  const downstream = computeDownstreamHitAtK(events, topK);

  let rankingEvents = 0;
  let rankingShadowEvents = 0;
  let rankingActiveEvents = 0;
  let rankingChangedEvents = 0;
  let rankingTop1Flips = 0;
  const rankingChangedPositions: number[] = [];
  const rankingKendallDistances: number[] = [];
  const deterministicHitAtK = Array.from({ length: topK }, () => 0);
  const inferredHitAtK = Array.from({ length: topK }, () => 0);
  const deterministicPrecisionAtK = Array.from({ length: topK }, () => 0);
  const inferredPrecisionAtK = Array.from({ length: topK }, () => 0);
  let deterministicSupersededHits = 0;
  let inferredSupersededHits = 0;
  let deterministicTotalTopKIds = 0;
  let inferredTotalTopKIds = 0;

  const skippedReasons = new Map<string, number>();
  let rankingFailedEvents = 0;
  let externalInjectedEvents = 0;
  let externalSkippedEvents = 0;
  let externalInjectedHitCount = 0;
  let externalWritebackUnits = 0;
  const externalSkipReasons = new Map<string, number>();
  let globalRecallEvents = 0;
  const globalRecallMatchedHits: number[] = [];
  const sessionSet = new Set<string>();

  for (const event of events) {
    sessionSet.add(event.sessionId);
    if (event.type === "cognitive_relevance_ranking") {
      const payload = event.payload ?? {};
      const query = toNonEmptyString(payload.query) ?? "";
      const deterministicTopIds = parseStringArray(payload.deterministicTopIds);
      const inferredTopIds = parseStringArray(payload.inferredTopIds);
      if (deterministicTopIds.length === 0 || inferredTopIds.length === 0 || !query) {
        continue;
      }
      rankingEvents += 1;
      const mode = toNonEmptyString(payload.mode) ?? "unknown";
      if (mode === "shadow") rankingShadowEvents += 1;
      if (mode === "active") rankingActiveEvents += 1;
      const changedPositions = toFiniteNumber(payload.changedPositions) ?? 0;
      rankingChangedPositions.push(changedPositions);
      if (changedPositions > 0) rankingChangedEvents += 1;
      if (deterministicTopIds[0] !== inferredTopIds[0]) rankingTop1Flips += 1;
      rankingKendallDistances.push(normalizedKendallDistance(deterministicTopIds, inferredTopIds));

      for (let offset = 0; offset < topK; offset += 1) {
        const windowSize = offset + 1;
        const deterministicWindow = deterministicTopIds.slice(0, windowSize);
        const inferredWindow = inferredTopIds.slice(0, windowSize);
        const deterministicMatches = deterministicWindow.filter((id) => {
          const candidate = memoryIndex.get(id);
          return candidate ? lexicalOverlap(query, candidate.text) >= 0.25 : false;
        }).length;
        const inferredMatches = inferredWindow.filter((id) => {
          const candidate = memoryIndex.get(id);
          return candidate ? lexicalOverlap(query, candidate.text) >= 0.25 : false;
        }).length;
        if (deterministicMatches > 0) {
          deterministicHitAtK[offset] = (deterministicHitAtK[offset] ?? 0) + 1;
        }
        if (inferredMatches > 0) {
          inferredHitAtK[offset] = (inferredHitAtK[offset] ?? 0) + 1;
        }
        deterministicPrecisionAtK[offset] =
          (deterministicPrecisionAtK[offset] ?? 0) +
          deterministicMatches / Math.max(1, deterministicWindow.length);
        inferredPrecisionAtK[offset] =
          (inferredPrecisionAtK[offset] ?? 0) +
          inferredMatches / Math.max(1, inferredWindow.length);
      }

      const deterministicTop = deterministicTopIds.slice(0, topK);
      const inferredTop = inferredTopIds.slice(0, topK);
      for (const id of deterministicTop) {
        const candidate = memoryIndex.get(id);
        if (!candidate) continue;
        deterministicTotalTopKIds += 1;
        if (candidate.status === "superseded") deterministicSupersededHits += 1;
      }
      for (const id of inferredTop) {
        const candidate = memoryIndex.get(id);
        if (!candidate) continue;
        inferredTotalTopKIds += 1;
        if (candidate.status === "superseded") inferredSupersededHits += 1;
      }
      continue;
    }

    if (event.type === "cognitive_relevance_ranking_skipped") {
      const reason = toNonEmptyString(event.payload?.reason) ?? "unknown";
      skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1);
      continue;
    }

    if (event.type === "cognitive_relevance_ranking_failed") {
      rankingFailedEvents += 1;
      continue;
    }

    if (event.type === "context_external_recall_injected") {
      externalInjectedEvents += 1;
      externalInjectedHitCount += toFiniteNumber(event.payload?.hitCount) ?? 0;
      externalWritebackUnits += toFiniteNumber(event.payload?.writebackUnits) ?? 0;
      continue;
    }

    if (event.type === "context_external_recall_skipped") {
      externalSkippedEvents += 1;
      const reason = toNonEmptyString(event.payload?.reason) ?? "unknown";
      externalSkipReasons.set(reason, (externalSkipReasons.get(reason) ?? 0) + 1);
      continue;
    }

    if (event.type === "memory_global_recall") {
      globalRecallEvents += 1;
      const matched = toFiniteNumber(event.payload?.matchedGlobalHits) ?? 0;
      globalRecallMatchedHits.push(matched);
    }
  }

  const rankingSampleCount = Math.max(1, rankingEvents);
  const deterministicHitAtKRate = deterministicHitAtK.map((value) =>
    round4(value / rankingSampleCount),
  );
  const inferredHitAtKRate = inferredHitAtK.map((value) => round4(value / rankingSampleCount));
  const deterministicPrecisionAtKRate = deterministicPrecisionAtK.map((value) =>
    round4(value / rankingSampleCount),
  );
  const inferredPrecisionAtKRate = inferredPrecisionAtK.map((value) =>
    round4(value / rankingSampleCount),
  );

  const deterministicDownstreamHitAtKRate = downstream.deterministicDownstreamHitAtK.map((value) =>
    round4(value / rankingSampleCount),
  );
  const inferredDownstreamHitAtKRate = downstream.inferredDownstreamHitAtK.map((value) =>
    round4(value / rankingSampleCount),
  );

  const top1PrecisionDelta =
    (inferredPrecisionAtKRate[0] ?? 0) - (deterministicPrecisionAtKRate[0] ?? 0);
  const top1FlipRate = rankingEvents > 0 ? rankingTop1Flips / rankingEvents : 0;
  const changedRate = rankingEvents > 0 ? rankingChangedEvents / rankingEvents : 0;
  const meanKendall = average(rankingKendallDistances);
  const downstreamTop1Delta =
    (downstream.inferredDownstreamHitAtK[0] ?? 0) / rankingSampleCount -
    (downstream.deterministicDownstreamHitAtK[0] ?? 0) / rankingSampleCount;
  const significantDifference =
    top1FlipRate >= 0.2 ||
    Math.abs(top1PrecisionDelta) >= 0.05 ||
    meanKendall >= 0.25 ||
    Math.abs(downstreamTop1Delta) >= 0.05;

  let promotionRecommendation:
    | "collect_more_shadow_data"
    | "insignificant_difference_keep_shadow"
    | "promote_to_active_candidate"
    | "do_not_promote";
  if (rankingShadowEvents < options.minShadowSamples) {
    promotionRecommendation = "collect_more_shadow_data";
  } else if (!significantDifference) {
    promotionRecommendation = "insignificant_difference_keep_shadow";
  } else if (top1PrecisionDelta > 0 || downstreamTop1Delta > 0) {
    promotionRecommendation = "promote_to_active_candidate";
  } else {
    promotionRecommendation = "do_not_promote";
  }

  const summary = {
    schema: "brewva.memory.recall.analysis.v1",
    generatedAt: Date.now(),
    inputs: {
      eventsDir,
      memoryDir,
      topK,
      minShadowSamples: options.minShadowSamples,
    },
    coverage: {
      sessions: sessionSet.size,
      events: events.length,
      rankingEvents,
      rankingShadowEvents,
      rankingActiveEvents,
    },
    ranking: {
      changedRate: round4(changedRate),
      top1FlipRate: round4(top1FlipRate),
      meanChangedPositions: round4(average(rankingChangedPositions)),
      meanKendallDistance: round4(meanKendall),
      deterministicHitAtKRate,
      inferredHitAtKRate,
      deterministicPrecisionAtKRate,
      inferredPrecisionAtKRate,
      deterministicDownstreamHitAtKRate,
      inferredDownstreamHitAtKRate,
      downstreamReferencedIdsCount: downstream.downstreamReferencedIdsCount,
      precisionDeltaTop1: round4(top1PrecisionDelta),
      deterministicSupersededHitRate:
        deterministicTotalTopKIds > 0
          ? round4(deterministicSupersededHits / deterministicTotalTopKIds)
          : 0,
      inferredSupersededHitRate:
        inferredTotalTopKIds > 0 ? round4(inferredSupersededHits / inferredTotalTopKIds) : 0,
      skippedReasons: Object.fromEntries(
        [...skippedReasons.entries()].toSorted((a, b) => b[1] - a[1]),
      ),
      failedEvents: rankingFailedEvents,
      significantDifference,
      promotionRecommendation,
    },
    externalRecall: {
      injectedEvents: externalInjectedEvents,
      skippedEvents: externalSkippedEvents,
      injectedRate:
        externalInjectedEvents + externalSkippedEvents > 0
          ? round4(externalInjectedEvents / (externalInjectedEvents + externalSkippedEvents))
          : 0,
      avgInjectedHitCount:
        externalInjectedEvents > 0 ? round4(externalInjectedHitCount / externalInjectedEvents) : 0,
      avgWritebackUnits:
        externalInjectedEvents > 0 ? round4(externalWritebackUnits / externalInjectedEvents) : 0,
      skippedReasons: Object.fromEntries(
        [...externalSkipReasons.entries()].toSorted((a, b) => b[1] - a[1]),
      ),
    },
    globalRecall: {
      events: globalRecallEvents,
      avgMatchedGlobalHits:
        globalRecallMatchedHits.length > 0 ? round4(average(globalRecallMatchedHits)) : 0,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
