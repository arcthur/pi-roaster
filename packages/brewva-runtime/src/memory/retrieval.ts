import { differenceInMilliseconds } from "date-fns";
import {
  buildKnowledgeFacetsFromCrystalProtocol,
  buildKnowledgeFacetsFromLessonProtocol,
  readGlobalCrystalProtocol,
  readGlobalLessonProtocol,
  readLearningKnowledgeFacets,
} from "./global-protocol.js";
import {
  MEMORY_RANKING_SIGNAL_SCHEMA,
  MEMORY_SEARCH_RESULT_SCHEMA,
  type MemoryCrystal,
  type MemorySearchHit,
  type MemorySearchRankingModel,
  type MemorySearchRankingSignal,
  type MemorySearchResult,
  type MemoryUnit,
} from "./types.js";

export interface MemoryRetrievalWeights {
  lexical: number;
  recency: number;
  confidence: number;
}

const DEFAULT_RETRIEVAL_WEIGHTS: MemoryRetrievalWeights = {
  lexical: 0.55,
  recency: 0.25,
  confidence: 0.2,
};

const SEARCH_RESULT_VERSION = 1 as const;
const GLOBAL_SESSION_ID = "__global__";

const TOKEN_ALIASES: Record<string, string[]> = {
  db: ["database", "sql", "postgres", "postgresql", "mysql", "sqlite"],
  database: ["db", "sql", "postgres", "postgresql", "mysql", "sqlite"],
  postgres: ["postgresql", "database", "db", "sql"],
  postgresql: ["postgres", "database", "db", "sql"],
  sql: ["database", "db", "postgres", "postgresql", "mysql", "sqlite"],
  test: ["tests", "testing", "verification"],
  tests: ["test", "testing", "verification"],
  verification: ["verify", "validated", "testing", "test"],
  verify: ["verification", "validated", "testing", "test"],
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stem(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("tion")) return token.slice(0, -4);
  if (token.endsWith("sion")) return token.slice(0, -4);
  if (token.endsWith("ment")) return token.slice(0, -4);
  if (token.endsWith("ness")) return token.slice(0, -4);
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  const expanded = new Set<string>();
  for (const raw of matches) {
    const token = raw.trim();
    if (!token) continue;
    const stemmed = stem(token);
    expanded.add(stemmed);
    const aliases = TOKEN_ALIASES[token] ?? TOKEN_ALIASES[stemmed];
    if (!aliases) continue;
    for (const alias of aliases) {
      expanded.add(stem(alias));
    }
  }
  return [...expanded];
}

function lexicalScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
  const querySet = new Set(queryTokens);
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of querySet) {
    if (candidateSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, querySet.size);
}

function recencyScore(updatedAt: number): number {
  const ageMs = Math.max(0, differenceInMilliseconds(Date.now(), updatedAt));
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + ageDays);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toExcerpt(text: string, maxChars = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function normalizeWeights(input?: MemoryRetrievalWeights): MemoryRetrievalWeights {
  const lexical = input?.lexical ?? DEFAULT_RETRIEVAL_WEIGHTS.lexical;
  const recency = input?.recency ?? DEFAULT_RETRIEVAL_WEIGHTS.recency;
  const confidence = input?.confidence ?? DEFAULT_RETRIEVAL_WEIGHTS.confidence;
  const safeLexical = Math.max(0, lexical);
  const safeRecency = Math.max(0, recency);
  const safeConfidence = Math.max(0, confidence);
  const total = safeLexical + safeRecency + safeConfidence;
  if (total <= 0) return { ...DEFAULT_RETRIEVAL_WEIGHTS };
  return {
    lexical: safeLexical / total,
    recency: safeRecency / total,
    confidence: safeConfidence / total,
  };
}

function weakSemanticFloor(weights: MemoryRetrievalWeights): number {
  return Math.max(0.05, Math.min(0.2, (weights.recency + weights.confidence) * 0.35));
}

function sourceTierForSession(
  sessionId: string,
  metadata?: Record<string, unknown>,
): MemorySearchHit["sourceTier"] {
  const sourceTier = typeof metadata?.["sourceTier"] === "string" ? metadata["sourceTier"] : null;
  if (sourceTier === "external") return "external";
  return sessionId === GLOBAL_SESSION_ID ? "global" : "session";
}

function buildRankingSignal(input: {
  lexical: number;
  recency: number;
  confidence: number;
  weights: MemoryRetrievalWeights;
  weakSemantic: boolean;
}): MemorySearchRankingSignal {
  const semanticScale = input.weakSemantic ? 0.45 : 1;
  return {
    schema: MEMORY_RANKING_SIGNAL_SCHEMA,
    lexical: input.lexical,
    recency: input.recency,
    confidence: input.confidence,
    weightedLexical: input.weakSemantic ? 0 : input.weights.lexical * input.lexical,
    weightedRecency: input.weights.recency * input.recency * semanticScale,
    weightedConfidence: input.weights.confidence * input.confidence * semanticScale,
    weakSemantic: input.weakSemantic,
    rank: 0,
  };
}

function rankSignalScore(signal: MemorySearchRankingSignal): number {
  return signal.weightedLexical + signal.weightedRecency + signal.weightedConfidence;
}

function scoreUnit(
  queryTokens: string[],
  unit: MemoryUnit,
  weights: MemoryRetrievalWeights,
): MemorySearchHit | null {
  if (unit.status === "superseded") return null;
  if (
    unit.type === "learning" &&
    unit.status === "resolved" &&
    unit.metadata?.["lessonOutcome"] === "fail"
  ) {
    return null;
  }
  const taskKind = unit.metadata?.["taskKind"];
  if (taskKind === "status_set" && unit.metadata?.["memorySignal"] !== "verification") return null;
  const lexical = lexicalScore(queryTokens, tokenize(`${unit.topic} ${unit.statement}`));
  const recency = recencyScore(unit.updatedAt);
  const confidence = clampConfidence(unit.confidence);
  const ranking = buildRankingSignal({
    lexical,
    recency,
    confidence,
    weights,
    weakSemantic: lexical <= 0,
  });
  const score = rankSignalScore(ranking);
  if (ranking.weakSemantic && score < weakSemanticFloor(weights)) return null;
  if (score <= 0) return null;
  const lessonProtocol =
    unit.sessionId === GLOBAL_SESSION_ID && unit.type === "learning"
      ? (readGlobalLessonProtocol(unit.metadata) ?? undefined)
      : undefined;
  const knowledgeFacets =
    unit.type === "learning"
      ? (readLearningKnowledgeFacets(unit.metadata) ?? undefined)
      : undefined;
  return {
    kind: "unit",
    id: unit.id,
    sourceTier: sourceTierForSession(unit.sessionId, unit.metadata),
    topic: unit.topic,
    excerpt: toExcerpt(unit.statement),
    score,
    confidence,
    updatedAt: unit.updatedAt,
    ranking,
    lessonProtocol,
    knowledgeFacets:
      knowledgeFacets ??
      (lessonProtocol ? buildKnowledgeFacetsFromLessonProtocol(lessonProtocol) : undefined),
  };
}

function scoreCrystal(
  queryTokens: string[],
  crystal: MemoryCrystal,
  weights: MemoryRetrievalWeights,
): MemorySearchHit | null {
  const lexical = lexicalScore(queryTokens, tokenize(`${crystal.topic} ${crystal.summary}`));
  const recency = recencyScore(crystal.updatedAt);
  const confidence = clampConfidence(crystal.confidence);
  const ranking = buildRankingSignal({
    lexical,
    recency,
    confidence,
    weights,
    weakSemantic: lexical <= 0,
  });
  const score = rankSignalScore(ranking);
  if (ranking.weakSemantic && score < weakSemanticFloor(weights)) return null;
  if (score <= 0) return null;
  const protocol = readGlobalCrystalProtocol(crystal.metadata) ?? undefined;
  return {
    kind: "crystal",
    id: crystal.id,
    sourceTier: sourceTierForSession(crystal.sessionId, crystal.metadata),
    topic: crystal.topic,
    excerpt: toExcerpt(crystal.summary),
    score,
    confidence,
    updatedAt: crystal.updatedAt,
    ranking,
    unitIds: crystal.unitIds,
    crystalProtocol: protocol,
    knowledgeFacets: protocol ? buildKnowledgeFacetsFromCrystalProtocol(protocol) : undefined,
  };
}

function buildRankingModel(weights: MemoryRetrievalWeights): MemorySearchRankingModel {
  return {
    schema: MEMORY_RANKING_SIGNAL_SCHEMA,
    lexicalWeight: round3(weights.lexical),
    recencyWeight: round3(weights.recency),
    confidenceWeight: round3(weights.confidence),
  };
}

function finalizeHit(hit: MemorySearchHit, rank: number): MemorySearchHit {
  return {
    ...hit,
    score: round3(hit.score),
    confidence: round3(hit.confidence),
    ranking: {
      ...hit.ranking,
      lexical: round3(hit.ranking.lexical),
      recency: round3(hit.ranking.recency),
      confidence: round3(hit.ranking.confidence),
      weightedLexical: round3(hit.ranking.weightedLexical),
      weightedRecency: round3(hit.ranking.weightedRecency),
      weightedConfidence: round3(hit.ranking.weightedConfidence),
      rank,
    },
  };
}

export function searchMemory(input: {
  sessionId: string;
  includeSessionIds?: string[];
  query: string;
  units: MemoryUnit[];
  crystals: MemoryCrystal[];
  limit: number;
  weights?: MemoryRetrievalWeights;
}): MemorySearchResult {
  const query = input.query.trim();
  const weights = normalizeWeights(input.weights);
  const rankingModel = buildRankingModel(weights);
  if (!query) {
    return {
      schema: MEMORY_SEARCH_RESULT_SCHEMA,
      version: SEARCH_RESULT_VERSION,
      generatedAt: Date.now(),
      rankingModel,
      sessionId: input.sessionId,
      query,
      scanned: 0,
      hits: [],
    };
  }

  const queryTokens = tokenize(query);
  const allowedSessionIds = new Set<string>([input.sessionId]);
  for (const extraSessionId of input.includeSessionIds ?? []) {
    const normalized = extraSessionId.trim();
    if (!normalized) continue;
    allowedSessionIds.add(normalized);
  }
  const hits: MemorySearchHit[] = [];
  let scanned = 0;

  for (const unit of input.units) {
    if (!allowedSessionIds.has(unit.sessionId)) continue;
    const hit = scoreUnit(queryTokens, unit, weights);
    scanned += 1;
    if (!hit) continue;
    hits.push(hit);
  }

  for (const crystal of input.crystals) {
    if (!allowedSessionIds.has(crystal.sessionId)) continue;
    const hit = scoreCrystal(queryTokens, crystal, weights);
    scanned += 1;
    if (!hit) continue;
    hits.push(hit);
  }

  const limit = Math.max(1, Math.floor(input.limit));
  const selected = hits
    .toSorted((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, limit)
    .map((hit, index) => finalizeHit(hit, index + 1));

  return {
    schema: MEMORY_SEARCH_RESULT_SCHEMA,
    version: SEARCH_RESULT_VERSION,
    generatedAt: Date.now(),
    rankingModel,
    sessionId: input.sessionId,
    query,
    scanned,
    hits: selected,
  };
}
