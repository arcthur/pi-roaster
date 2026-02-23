import type { JsonValue } from "../utils/json.js";

export type MemoryUnitType =
  | "fact"
  | "decision"
  | "constraint"
  | "preference"
  | "pattern"
  | "hypothesis"
  | "learning"
  | "risk";

export type MemoryUnitStatus = "active" | "resolved" | "superseded"; // Used when an accepted evolves edge replaces/challenges an older unit

export type MemoryInsightKind = "conflict" | "evolves_pending";

export type MemoryInsightStatus = "open" | "dismissed";

export type MemoryEvolvesRelation = "replaces" | "enriches" | "confirms" | "challenges";

export type MemoryEvolvesEdgeStatus =
  | "proposed" // Route A: shadow-only candidate edges
  | "accepted" // Manual review accepted (may apply side-effects like superseding units)
  | "rejected"; // Manual review rejected

export interface MemorySourceRef {
  eventId: string;
  eventType: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
  evidenceId?: string;
}

export interface MemoryUnit {
  id: string;
  sessionId: string;
  type: MemoryUnitType;
  status: MemoryUnitStatus;
  topic: string;
  statement: string;
  confidence: number;
  fingerprint: string;
  sourceRefs: MemorySourceRef[];
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
  supersededAt?: number;
}

export interface MemoryCrystal {
  id: string;
  sessionId: string;
  topic: string;
  summary: string;
  unitIds: string[];
  confidence: number;
  sourceRefs: MemorySourceRef[];
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
}

export const MEMORY_SEARCH_RESULT_SCHEMA = "brewva.memory.search.v1";
export const MEMORY_RANKING_SIGNAL_SCHEMA = "brewva.memory.ranking.v1";
export const GLOBAL_CRYSTAL_PROTOCOL_SCHEMA = "brewva.memory.global-crystal.v1";
export const GLOBAL_LESSON_PROTOCOL_SCHEMA = "brewva.memory.global-lesson.v1";

export interface MemorySearchRankingSignal {
  schema: typeof MEMORY_RANKING_SIGNAL_SCHEMA;
  lexical: number;
  recency: number;
  confidence: number;
  weightedLexical: number;
  weightedRecency: number;
  weightedConfidence: number;
  weakSemantic: boolean;
  rank: number;
}

export interface MemorySearchRankingModel {
  schema: typeof MEMORY_RANKING_SIGNAL_SCHEMA;
  lexicalWeight: number;
  recencyWeight: number;
  confidenceWeight: number;
}

export interface MemoryKnowledgeFacets {
  pattern: string | null;
  patterns: string[];
  rootCause: string | null;
  rootCauses: string[];
  recommendation: string | null;
  recommendations: string[];
  lessonKey: string | null;
  lessonKeys: string[];
  outcomes: {
    pass: number;
    fail: number;
  };
  sourceSessionIds: string[];
  sourceSessionCount: number;
  unitCount: number | null;
}

export interface MemoryGlobalCrystalProtocol {
  schema: typeof GLOBAL_CRYSTAL_PROTOCOL_SCHEMA;
  version: 1;
  pattern: string | null;
  patterns: string[];
  rootCause: string | null;
  rootCauses: string[];
  recommendation: string | null;
  recommendations: string[];
  lessonKeys: string[];
  outcomes: {
    pass: number;
    fail: number;
  };
  sourceSessionIds: string[];
  sourceSessionCount: number;
  unitCount: number;
  updatedAt: number;
}

export interface MemoryGlobalLessonProtocol {
  schema: typeof GLOBAL_LESSON_PROTOCOL_SCHEMA;
  version: 1;
  lessonKey: string | null;
  pattern: string | null;
  patterns: string[];
  rootCause: string | null;
  rootCauses: string[];
  recommendation: string | null;
  recommendations: string[];
  outcomes: {
    pass: number;
    fail: number;
  };
  sourceSessionIds: string[];
  sourceSessionCount: number;
  updatedAt: number;
}

export interface MemoryInsight {
  id: string;
  sessionId: string;
  kind: MemoryInsightKind;
  status: MemoryInsightStatus;
  message: string;
  relatedUnitIds: string[];
  edgeId?: string;
  relation?: MemoryEvolvesRelation;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEvolvesEdge {
  id: string;
  sessionId: string;
  sourceUnitId: string;
  targetUnitId: string;
  relation: MemoryEvolvesRelation;
  status: MemoryEvolvesEdgeStatus;
  confidence: number;
  rationale?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkingMemorySection {
  title: "Now" | "Decisions" | "Constraints" | "Risks" | "Lessons Learned" | "Open Threads";
  lines: string[];
}

export interface WorkingMemorySnapshot {
  sessionId: string;
  generatedAt: number;
  sourceUnitIds: string[];
  crystalIds: string[];
  insightIds: string[];
  sections: WorkingMemorySection[];
  content: string;
}

export interface MemorySearchHit {
  kind: "unit" | "crystal";
  id: string;
  sourceTier: "session" | "global";
  topic: string;
  excerpt: string;
  score: number;
  confidence: number;
  updatedAt: number;
  ranking: MemorySearchRankingSignal;
  unitIds?: string[];
  knowledgeFacets?: MemoryKnowledgeFacets;
  crystalProtocol?: MemoryGlobalCrystalProtocol;
  lessonProtocol?: MemoryGlobalLessonProtocol;
}

export interface MemorySearchResult {
  schema: typeof MEMORY_SEARCH_RESULT_SCHEMA;
  version: 1;
  generatedAt: number;
  rankingModel: MemorySearchRankingModel;
  sessionId: string;
  query: string;
  scanned: number;
  hits: MemorySearchHit[];
}

export interface MemoryStoreState {
  schemaVersion: number;
  lastPublishedAt: number | null;
  lastPublishedDayKey: string | null;
  dirtyTopics: string[];
}

export interface MemoryUnitCandidate {
  sessionId: string;
  type: MemoryUnitType;
  status: MemoryUnitStatus;
  topic: string;
  statement: string;
  confidence: number;
  metadata?: Record<string, JsonValue>;
  sourceRefs: MemorySourceRef[];
}

export interface MemoryUnitResolveDirective {
  sessionId: string;
  sourceType: "truth_fact" | "task_blocker" | "memory_signal" | "task_kind" | "lesson_key";
  sourceId: string;
  resolvedAt: number;
}

export interface MemoryExtractionResult {
  upserts: MemoryUnitCandidate[];
  resolves: MemoryUnitResolveDirective[];
}
