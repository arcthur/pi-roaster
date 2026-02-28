import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExternalRecallHit, ExternalRecallPort } from "./types.js";

const DEFAULT_HASHING_DIMENSIONS = 384;
const DEFAULT_MIN_SIMILARITY = 0.08;
const DEFAULT_MAX_CANDIDATES = 1200;
const MAX_QUERY_LIMIT = 64;

interface CrystalProjectionRow {
  id: string;
  sessionId: string;
  topic: string;
  summary: string;
  confidence?: number;
  updatedAt?: number;
}

interface CrystalLexicalCandidate {
  id: string;
  sessionId: string;
  topic: string;
  summary: string;
  confidence: number;
  updatedAt: number;
  embedding: Map<number, number>;
}

interface CandidateCacheSnapshot {
  signature: string;
  rows: CrystalLexicalCandidate[];
}

export interface CrystalLexicalExternalRecallPortOptions {
  memoryRootDir: string;
  includeWorkspaceCrystals?: boolean;
  includeGlobalCrystals?: boolean;
  maxCandidates?: number;
  minSimilarity?: number;
  embeddingDimensions?: number;
}

function clampUnitInterval(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  return matches.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildEmbedding(text: string, dimensions: number): Map<number, number> {
  const counts = new Map<number, number>();
  const tokens = tokenize(text);
  if (tokens.length === 0) return counts;
  for (const token of tokens) {
    const bucket = fnv1a32(token) % dimensions;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  let norm = 0;
  for (const value of counts.values()) {
    norm += value * value;
  }
  if (norm <= 0) return new Map();
  const scale = Math.sqrt(norm);
  const normalized = new Map<number, number>();
  for (const [bucket, value] of counts.entries()) {
    normalized.set(bucket, value / scale);
  }
  return normalized;
}

function cosineSimilarity(left: Map<number, number>, right: Map<number, number>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const iterateLeft = left.size <= right.size;
  const source = iterateLeft ? left : right;
  const target = iterateLeft ? right : left;
  let dot = 0;
  for (const [bucket, value] of source.entries()) {
    dot += value * (target.get(bucket) ?? 0);
  }
  return dot;
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

function normalizeCrystalRow(value: unknown): CrystalProjectionRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<CrystalProjectionRow>;
  if (typeof row.id !== "string" || row.id.trim().length === 0) return null;
  if (typeof row.sessionId !== "string" || row.sessionId.trim().length === 0) return null;
  if (typeof row.topic !== "string" || row.topic.trim().length === 0) return null;
  if (typeof row.summary !== "string" || row.summary.trim().length === 0) return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    topic: row.topic.trim(),
    summary: row.summary.trim(),
    confidence:
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : undefined,
    updatedAt:
      typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
        ? row.updatedAt
        : undefined,
  };
}

function projectionFileSignature(path: string): string {
  if (!existsSync(path)) return `${path}:missing`;
  try {
    const stats = statSync(path);
    return `${path}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return `${path}:error`;
  }
}

export class CrystalLexicalExternalRecallPort implements ExternalRecallPort {
  private readonly memoryRootDir: string;
  private readonly includeWorkspaceCrystals: boolean;
  private readonly includeGlobalCrystals: boolean;
  private readonly maxCandidates: number;
  private readonly minSimilarity: number;
  private readonly embeddingDimensions: number;
  private cache: CandidateCacheSnapshot | null = null;

  constructor(options: CrystalLexicalExternalRecallPortOptions) {
    this.memoryRootDir = resolve(options.memoryRootDir);
    this.includeWorkspaceCrystals = options.includeWorkspaceCrystals ?? false;
    this.includeGlobalCrystals = options.includeGlobalCrystals ?? true;
    this.maxCandidates = Math.max(100, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
    this.minSimilarity = clampUnitInterval(options.minSimilarity ?? DEFAULT_MIN_SIMILARITY, 0);
    this.embeddingDimensions = Math.max(
      64,
      Math.floor(options.embeddingDimensions ?? DEFAULT_HASHING_DIMENSIONS),
    );
  }

  async search(input: {
    sessionId: string;
    query: string;
    limit: number;
  }): Promise<ExternalRecallHit[]> {
    const queryText = input.query.trim();
    if (!queryText) return [];
    const maxHits = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(input.limit)));
    const queryEmbedding = buildEmbedding(queryText, this.embeddingDimensions);
    if (queryEmbedding.size === 0) return [];

    const candidates = this.loadCandidates();
    if (candidates.length === 0) return [];

    const scored = candidates
      .filter((candidate) => candidate.sessionId !== input.sessionId)
      .map((candidate) => {
        const similarity = cosineSimilarity(queryEmbedding, candidate.embedding);
        return {
          candidate,
          similarity,
        };
      })
      .filter((entry) => entry.similarity >= this.minSimilarity)
      .toSorted((left, right) => {
        if (right.similarity !== left.similarity) return right.similarity - left.similarity;
        return right.candidate.updatedAt - left.candidate.updatedAt;
      })
      .slice(0, maxHits);

    return scored.map((entry) => ({
      topic: entry.candidate.topic,
      excerpt: entry.candidate.summary,
      score: round3(entry.similarity),
      confidence: entry.candidate.confidence,
      metadata: {
        source: "memory_crystal_lexical",
        crystalId: entry.candidate.id,
        crystalSessionId: entry.candidate.sessionId,
        updatedAt: entry.candidate.updatedAt,
      },
    }));
  }

  private loadCandidates(): CrystalLexicalCandidate[] {
    const projectionFiles: string[] = [];
    if (this.includeWorkspaceCrystals) {
      projectionFiles.push(join(this.memoryRootDir, "crystals.jsonl"));
    }
    if (this.includeGlobalCrystals) {
      projectionFiles.push(join(this.memoryRootDir, "global", "crystals.jsonl"));
    }
    if (projectionFiles.length === 0) return [];
    const signature = projectionFiles.map((path) => projectionFileSignature(path)).join("|");
    if (this.cache?.signature === signature) {
      return this.cache.rows;
    }

    const latestById = new Map<string, CrystalProjectionRow>();
    for (const projectionFile of projectionFiles) {
      const rows = parseJsonLines(projectionFile);
      for (const raw of rows) {
        const row = normalizeCrystalRow(raw);
        if (!row) continue;
        const existing = latestById.get(row.id);
        const rowUpdatedAt = row.updatedAt ?? 0;
        const existingUpdatedAt = existing?.updatedAt ?? 0;
        if (!existing || rowUpdatedAt >= existingUpdatedAt) {
          latestById.set(row.id, row);
        }
      }
    }

    const rows = [...latestById.values()]
      .toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, this.maxCandidates)
      .map((row) => {
        const summary = row.summary.trim();
        const topic = row.topic.trim();
        const embedding = buildEmbedding(`${topic}\n${summary}`, this.embeddingDimensions);
        return {
          id: row.id,
          sessionId: row.sessionId,
          topic,
          summary,
          confidence: clampUnitInterval(row.confidence ?? 0.6, 0.6),
          updatedAt:
            typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
          embedding,
        };
      })
      .filter((row) => row.embedding.size > 0);

    this.cache = {
      signature,
      rows,
    };
    return rows;
  }
}

export function createCrystalLexicalExternalRecallPort(
  options: CrystalLexicalExternalRecallPortOptions,
): ExternalRecallPort {
  return new CrystalLexicalExternalRecallPort(options);
}
