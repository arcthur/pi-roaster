import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { differenceInMilliseconds } from "date-fns";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";
import type {
  MemoryCrystal,
  MemoryDirtyEntry,
  MemoryDirtyReason,
  MemoryEvolvesEdge,
  MemoryEvolvesEdgeStatus,
  MemoryInsight,
  MemoryStoreState,
  MemoryUnit,
  MemoryUnitCandidate,
  MemoryUnitResolveDirective,
  WorkingMemorySnapshot,
} from "./types.js";
import { mergeSourceRefs, normalizeText } from "./utils.js";

const MEMORY_STATE_SCHEMA_VERSION = 2;
const COMPACTION_LINE_THRESHOLD = 500;
const REFRESH_LOCK_STALE_MS = 30_000;
const VALID_MEMORY_DIRTY_REASONS = new Set<MemoryDirtyReason>([
  "new_unit",
  "resolve_directive",
  "external_recall",
  "evolves_edge_reviewed",
  "replay_new_unit",
  "replay_resolve_directive",
]);

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function nextUpdatedAt(currentUpdatedAt: number, proposedAt: number = Date.now()): number {
  return Math.max(proposedAt, currentUpdatedAt + 1);
}

function fingerprintForUnit(input: {
  type: MemoryUnitCandidate["type"];
  topic: string;
  statement: string;
}): string {
  return sha256(`${input.type}::${normalizeText(input.topic)}::${normalizeText(input.statement)}`);
}

function parseJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return out;
}

function isTombstoneRow(value: unknown): value is { id: string; _tombstone: true } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as { id?: unknown; _tombstone?: unknown };
  return row._tombstone === true && typeof row.id === "string";
}

function normalizeDirtyReason(value: unknown): MemoryDirtyReason | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim() as MemoryDirtyReason;
  return VALID_MEMORY_DIRTY_REASONS.has(normalized) ? normalized : null;
}

function normalizeDirtyEntries(entries: MemoryDirtyEntry[]): MemoryDirtyEntry[] {
  const latestByTopicReason = new Map<string, MemoryDirtyEntry>();
  for (const entry of entries) {
    const topic = entry.topic.trim();
    if (!topic) continue;
    const reason = normalizeDirtyReason(entry.reason);
    if (!reason) continue;
    const updatedAt =
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : Date.now();
    const key = `${topic}\u0000${reason}`;
    const existing = latestByTopicReason.get(key);
    if (!existing || updatedAt >= existing.updatedAt) {
      latestByTopicReason.set(key, {
        topic,
        reason,
        updatedAt,
      });
    }
  }
  return [...latestByTopicReason.values()].toSorted((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.topic !== right.topic) return left.topic.localeCompare(right.topic);
    return left.reason.localeCompare(right.reason);
  });
}

function defaultState(): MemoryStoreState {
  return {
    schemaVersion: MEMORY_STATE_SCHEMA_VERSION,
    lastPublishedAt: null,
    lastPublishedDayKey: null,
    dirtyEntries: [],
  };
}

export interface MemoryStoreOptions {
  rootDir: string;
  workingFile: string;
}

export class MemoryStore {
  private readonly rootDir: string;
  private readonly unitsPath: string;
  private readonly crystalsPath: string;
  private readonly insightsPath: string;
  private readonly evolvesPath: string;
  private readonly statePath: string;
  private readonly workingPath: string;
  private readonly refreshLockPath: string;

  private unitsLoaded = false;
  private crystalsLoaded = false;
  private insightsLoaded = false;
  private evolvesLoaded = false;
  private stateLoaded = false;
  private unitsLineCount = 0;
  private crystalsLineCount = 0;
  private insightsLineCount = 0;
  private evolvesLineCount = 0;
  private unitWriteAt = 0;

  private unitsById = new Map<string, MemoryUnit>();
  private unitIdBySessionFingerprint = new Map<string, string>();
  private crystalsById = new Map<string, MemoryCrystal>();
  private crystalIdBySessionTopic = new Map<string, string>();
  private insightsById = new Map<string, MemoryInsight>();
  private evolvesById = new Map<string, MemoryEvolvesEdge>();
  private state: MemoryStoreState = defaultState();
  private workingBySession = new Map<string, WorkingMemorySnapshot>();

  constructor(options: MemoryStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    ensureDir(this.rootDir);
    this.unitsPath = join(this.rootDir, "units.jsonl");
    this.crystalsPath = join(this.rootDir, "crystals.jsonl");
    this.insightsPath = join(this.rootDir, "insights.jsonl");
    this.evolvesPath = join(this.rootDir, "evolves.jsonl");
    this.statePath = join(this.rootDir, "state.json");
    this.workingPath = join(this.rootDir, options.workingFile);
    this.refreshLockPath = join(this.rootDir, ".refresh.lock");
  }

  upsertUnit(input: MemoryUnitCandidate): { unit: MemoryUnit; created: boolean } {
    this.ensureUnitsLoaded();
    const observedAt = Date.now();
    const normalizedTopic = input.topic.trim();
    const normalizedStatement = input.statement.trim();
    if (!normalizedTopic || !normalizedStatement) {
      throw new Error("Memory unit topic/statement cannot be empty.");
    }

    const fingerprint = fingerprintForUnit({
      type: input.type,
      topic: normalizedTopic,
      statement: normalizedStatement,
    });
    const key = `${input.sessionId}:${fingerprint}`;
    const existingId = this.unitIdBySessionFingerprint.get(key);
    const existing = existingId ? this.unitsById.get(existingId) : undefined;
    if (existing) {
      const updatedAt = this.nextUnitWriteAt(Math.max(existing.updatedAt + 1, observedAt));
      const nextStatus =
        existing.status === "superseded"
          ? "superseded"
          : input.status === "resolved"
            ? "resolved"
            : input.status;
      const merged: MemoryUnit = {
        ...existing,
        status: nextStatus,
        confidence: Math.max(existing.confidence, normalizeConfidence(input.confidence)),
        sourceRefs: mergeSourceRefs(existing.sourceRefs, input.sourceRefs),
        metadata:
          input.metadata && existing.metadata
            ? { ...existing.metadata, ...input.metadata }
            : (input.metadata ?? existing.metadata),
        updatedAt,
        lastSeenAt: updatedAt,
        resolvedAt:
          nextStatus === "resolved" ? (existing.resolvedAt ?? updatedAt) : existing.resolvedAt,
      };
      this.unitsById.set(merged.id, merged);
      this.appendJsonLine(this.unitsPath, merged);
      return { unit: merged, created: false };
    }

    const timestamp = this.nextUnitWriteAt(observedAt);
    const created: MemoryUnit = {
      id: nowId("memu"),
      sessionId: input.sessionId,
      type: input.type,
      status: input.status,
      topic: normalizedTopic,
      statement: normalizedStatement,
      confidence: normalizeConfidence(input.confidence),
      fingerprint,
      sourceRefs: mergeSourceRefs([], input.sourceRefs),
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      resolvedAt: input.status === "resolved" ? timestamp : undefined,
    };
    this.unitsById.set(created.id, created);
    this.unitIdBySessionFingerprint.set(key, created.id);
    this.appendJsonLine(this.unitsPath, created);
    return { unit: created, created: true };
  }

  resolveUnits(directive: MemoryUnitResolveDirective): number {
    this.ensureUnitsLoaded();
    let resolved = 0;
    for (const unit of this.unitsById.values()) {
      if (unit.sessionId !== directive.sessionId) continue;
      if (unit.status !== "active") continue;
      const matched = (() => {
        if (directive.sourceType === "truth_fact") {
          return unit.metadata?.truthFactId === directive.sourceId;
        }
        if (directive.sourceType === "task_blocker") {
          return unit.metadata?.taskBlockerId === directive.sourceId;
        }
        if (directive.sourceType === "memory_signal") {
          return unit.metadata?.memorySignal === directive.sourceId;
        }
        if (directive.sourceType === "task_kind") {
          return unit.metadata?.taskKind === directive.sourceId;
        }
        if (directive.sourceType === "lesson_key") {
          if (unit.metadata?.lessonKey !== directive.sourceId) return false;
          return unit.metadata?.lessonOutcome !== "pass";
        }
        return false;
      })();
      if (!matched) continue;
      const resolvedAt = this.nextUnitWriteAt(Math.max(unit.updatedAt + 1, directive.resolvedAt));
      const next: MemoryUnit = {
        ...unit,
        status: "resolved",
        updatedAt: resolvedAt,
        lastSeenAt: resolvedAt,
        resolvedAt,
      };
      this.unitsById.set(next.id, next);
      this.appendJsonLine(this.unitsPath, next);
      resolved += 1;
    }
    return resolved;
  }

  supersedeUnit(input: {
    sessionId: string;
    unitId: string;
    supersededByUnitId?: string;
    supersededByEdgeId?: string;
    relation?: MemoryEvolvesEdge["relation"];
    supersededAt?: number;
  }): { ok: true; updated: boolean; unit: MemoryUnit } | { ok: false; error: "not_found" } {
    this.ensureUnitsLoaded();
    const unit = this.unitsById.get(input.unitId);
    if (!unit || unit.sessionId !== input.sessionId) {
      return { ok: false, error: "not_found" };
    }
    if (unit.status === "superseded") {
      return { ok: true, updated: false, unit };
    }

    const observedAt = input.supersededAt ?? Date.now();
    const updatedAt = this.nextUnitWriteAt(Math.max(unit.updatedAt + 1, observedAt));
    const metadata: Record<string, unknown> = unit.metadata ? { ...unit.metadata } : {};
    metadata.supersededByUnitId = input.supersededByUnitId ?? null;
    metadata.supersededByEdgeId = input.supersededByEdgeId ?? null;
    metadata.supersededRelation = input.relation ?? null;
    const updated: MemoryUnit = {
      ...unit,
      status: "superseded",
      supersededAt: updatedAt,
      updatedAt,
      lastSeenAt: updatedAt,
      metadata: metadata as MemoryUnit["metadata"],
    };
    this.unitsById.set(updated.id, updated);
    this.appendJsonLine(this.unitsPath, updated);
    return { ok: true, updated: true, unit: updated };
  }

  getUnitById(unitId: string): MemoryUnit | undefined {
    this.ensureUnitsLoaded();
    const normalized = unitId.trim();
    if (!normalized) return undefined;
    return this.unitsById.get(normalized);
  }

  listUnits(sessionId?: string): MemoryUnit[] {
    this.ensureUnitsLoaded();
    const units = [...this.unitsById.values()];
    const filtered = sessionId ? units.filter((unit) => unit.sessionId === sessionId) : units;
    return filtered.toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  updateUnitConfidence(input: {
    sessionId: string;
    unitId: string;
    confidence: number;
    updatedAt?: number;
    metadata?: MemoryUnit["metadata"];
  }): { ok: true; updated: boolean; unit: MemoryUnit } | { ok: false; error: "not_found" } {
    this.ensureUnitsLoaded();
    const unit = this.unitsById.get(input.unitId);
    if (!unit || unit.sessionId !== input.sessionId) {
      return { ok: false, error: "not_found" };
    }
    const nextConfidence = normalizeConfidence(input.confidence);
    const nextMetadata =
      input.metadata && unit.metadata
        ? { ...unit.metadata, ...input.metadata }
        : (input.metadata ?? unit.metadata);
    const updatedAt = this.nextUnitWriteAt(
      Math.max(unit.updatedAt + 1, input.updatedAt ?? Date.now()),
    );
    const unchanged = nextConfidence === unit.confidence && nextMetadata === unit.metadata;
    if (unchanged) {
      return { ok: true, updated: false, unit };
    }
    const updated: MemoryUnit = {
      ...unit,
      confidence: nextConfidence,
      metadata: nextMetadata,
      updatedAt,
      lastSeenAt: updatedAt,
    };
    this.unitsById.set(updated.id, updated);
    this.appendJsonLine(this.unitsPath, updated);
    return { ok: true, updated: true, unit: updated };
  }

  removeUnit(unitId: string): boolean {
    this.ensureUnitsLoaded();
    const unit = this.unitsById.get(unitId);
    if (!unit) return false;
    this.unitsById.delete(unitId);
    this.unitIdBySessionFingerprint.delete(`${unit.sessionId}:${unit.fingerprint}`);
    // Append tombstone — compaction will clean it up at threshold
    this.appendJsonLine(this.unitsPath, { id: unitId, _tombstone: true });
    return true;
  }

  importUnitSnapshot(unit: MemoryUnit): { applied: boolean; unit?: MemoryUnit } {
    this.ensureUnitsLoaded();
    if (
      !unit ||
      typeof unit.id !== "string" ||
      typeof unit.sessionId !== "string" ||
      typeof unit.fingerprint !== "string" ||
      typeof unit.topic !== "string" ||
      typeof unit.statement !== "string" ||
      typeof unit.updatedAt !== "number" ||
      !Number.isFinite(unit.updatedAt)
    ) {
      return { applied: false };
    }

    const fingerprintKey = `${unit.sessionId}:${unit.fingerprint}`;
    const existingIdByFingerprint = this.unitIdBySessionFingerprint.get(fingerprintKey);
    if (existingIdByFingerprint && existingIdByFingerprint !== unit.id) {
      this.unitsById.delete(existingIdByFingerprint);
    }

    const existingById = this.unitsById.get(unit.id);
    if (existingById) {
      this.unitIdBySessionFingerprint.delete(
        `${existingById.sessionId}:${existingById.fingerprint}`,
      );
    }

    this.unitsById.set(unit.id, unit);
    this.unitIdBySessionFingerprint.set(fingerprintKey, unit.id);
    this.unitWriteAt = Math.max(this.unitWriteAt, unit.updatedAt);
    this.appendJsonLine(this.unitsPath, unit);
    return { applied: true, unit };
  }

  upsertCrystal(input: Omit<MemoryCrystal, "id" | "createdAt" | "updatedAt">): MemoryCrystal {
    this.ensureCrystalsLoaded();
    const timestamp = Date.now();
    const topic = input.topic.trim();
    if (!topic) {
      throw new Error("Memory crystal topic cannot be empty.");
    }
    const key = `${input.sessionId}:${normalizeText(topic)}`;
    const existingId = this.crystalIdBySessionTopic.get(key);
    const existing = existingId ? this.crystalsById.get(existingId) : undefined;
    if (existing) {
      const updatedAt = nextUpdatedAt(existing.updatedAt, timestamp);
      const merged: MemoryCrystal = {
        ...existing,
        topic,
        summary: input.summary.trim(),
        unitIds: [...new Set(input.unitIds)],
        sourceRefs: mergeSourceRefs(existing.sourceRefs, input.sourceRefs),
        confidence: normalizeConfidence(input.confidence),
        metadata:
          input.metadata && existing.metadata
            ? { ...existing.metadata, ...input.metadata }
            : (input.metadata ?? existing.metadata),
        updatedAt,
      };
      this.crystalsById.set(merged.id, merged);
      this.appendJsonLine(this.crystalsPath, merged);
      return merged;
    }

    const created: MemoryCrystal = {
      ...input,
      id: nowId("memc"),
      topic,
      summary: input.summary.trim(),
      unitIds: [...new Set(input.unitIds)],
      confidence: normalizeConfidence(input.confidence),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.crystalsById.set(created.id, created);
    this.crystalIdBySessionTopic.set(key, created.id);
    this.appendJsonLine(this.crystalsPath, created);
    return created;
  }

  listCrystals(sessionId?: string): MemoryCrystal[] {
    this.ensureCrystalsLoaded();
    const crystals = [...this.crystalsById.values()];
    const filtered = sessionId
      ? crystals.filter((crystal) => crystal.sessionId === sessionId)
      : crystals;
    return filtered.toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  removeCrystal(crystalId: string): boolean {
    this.ensureCrystalsLoaded();
    const crystal = this.crystalsById.get(crystalId);
    if (!crystal) return false;
    this.crystalsById.delete(crystalId);
    this.crystalIdBySessionTopic.delete(`${crystal.sessionId}:${normalizeText(crystal.topic)}`);
    // Append tombstone — compaction will clean it up at threshold
    this.appendJsonLine(this.crystalsPath, { id: crystalId, _tombstone: true });
    return true;
  }

  importCrystalSnapshot(crystal: MemoryCrystal): { applied: boolean; crystal?: MemoryCrystal } {
    this.ensureCrystalsLoaded();
    if (
      !crystal ||
      typeof crystal.id !== "string" ||
      typeof crystal.sessionId !== "string" ||
      typeof crystal.topic !== "string" ||
      typeof crystal.updatedAt !== "number" ||
      !Number.isFinite(crystal.updatedAt)
    ) {
      return { applied: false };
    }

    const topicKey = `${crystal.sessionId}:${normalizeText(crystal.topic)}`;
    const existingIdByTopic = this.crystalIdBySessionTopic.get(topicKey);
    if (existingIdByTopic && existingIdByTopic !== crystal.id) {
      this.crystalsById.delete(existingIdByTopic);
    }

    const existingById = this.crystalsById.get(crystal.id);
    if (existingById) {
      this.crystalIdBySessionTopic.delete(
        `${existingById.sessionId}:${normalizeText(existingById.topic)}`,
      );
    }

    this.crystalsById.set(crystal.id, crystal);
    this.crystalIdBySessionTopic.set(topicKey, crystal.id);
    this.appendJsonLine(this.crystalsPath, crystal);
    return { applied: true, crystal };
  }

  addInsight(input: Omit<MemoryInsight, "id" | "createdAt" | "updatedAt">): MemoryInsight {
    this.ensureInsightsLoaded();
    const timestamp = Date.now();
    const insight: MemoryInsight = {
      ...input,
      id: nowId("memi"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.insightsById.set(insight.id, insight);
    this.appendJsonLine(this.insightsPath, insight);
    return insight;
  }

  listInsights(sessionId?: string): MemoryInsight[] {
    this.ensureInsightsLoaded();
    const insights = [...this.insightsById.values()];
    const filtered = sessionId
      ? insights.filter((insight) => insight.sessionId === sessionId)
      : insights;
    return filtered.toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  importInsightSnapshot(insight: MemoryInsight): { applied: boolean; insight?: MemoryInsight } {
    this.ensureInsightsLoaded();
    if (
      !insight ||
      typeof insight.id !== "string" ||
      typeof insight.sessionId !== "string" ||
      typeof insight.updatedAt !== "number" ||
      !Number.isFinite(insight.updatedAt)
    ) {
      return { applied: false };
    }
    this.insightsById.set(insight.id, insight);
    this.appendJsonLine(this.insightsPath, insight);
    return { applied: true, insight };
  }

  addEvolvesEdge(
    input: Omit<MemoryEvolvesEdge, "id" | "createdAt" | "updatedAt">,
  ): MemoryEvolvesEdge {
    this.ensureEvolvesLoaded();
    const timestamp = Date.now();
    const edge: MemoryEvolvesEdge = {
      ...input,
      id: nowId("meme"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.evolvesById.set(edge.id, edge);
    this.appendJsonLine(this.evolvesPath, edge);
    return edge;
  }

  listEvolvesEdges(sessionId?: string): MemoryEvolvesEdge[] {
    this.ensureEvolvesLoaded();
    const edges = [...this.evolvesById.values()];
    const filtered = sessionId ? edges.filter((edge) => edge.sessionId === sessionId) : edges;
    return filtered.toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  importEvolvesEdgeSnapshot(edge: MemoryEvolvesEdge): {
    applied: boolean;
    edge?: MemoryEvolvesEdge;
  } {
    this.ensureEvolvesLoaded();
    if (
      !edge ||
      typeof edge.id !== "string" ||
      typeof edge.sessionId !== "string" ||
      typeof edge.updatedAt !== "number" ||
      !Number.isFinite(edge.updatedAt)
    ) {
      return { applied: false };
    }
    this.evolvesById.set(edge.id, edge);
    this.appendJsonLine(this.evolvesPath, edge);
    return { applied: true, edge };
  }

  setEvolvesEdgeStatus(
    sessionId: string,
    edgeId: string,
    status: MemoryEvolvesEdgeStatus,
  ): { ok: true; updated: boolean; edge: MemoryEvolvesEdge } | { ok: false; error: "not_found" } {
    this.ensureEvolvesLoaded();
    const edge = this.evolvesById.get(edgeId);
    if (!edge || edge.sessionId !== sessionId) {
      return { ok: false, error: "not_found" };
    }
    if (edge.status === status) {
      return { ok: true, updated: false, edge };
    }
    const updatedAt = nextUpdatedAt(edge.updatedAt);
    const updated: MemoryEvolvesEdge = {
      ...edge,
      status,
      updatedAt,
    };
    this.evolvesById.set(updated.id, updated);
    this.appendJsonLine(this.evolvesPath, updated);
    return { ok: true, updated: true, edge: updated };
  }

  updateEvolvesEdgeRelation(input: {
    edgeId: string;
    relation: MemoryEvolvesEdge["relation"];
    confidence?: number;
    rationale?: string;
  }): boolean {
    this.ensureEvolvesLoaded();
    const edge = this.evolvesById.get(input.edgeId);
    if (!edge) return false;
    const updated: MemoryEvolvesEdge = {
      ...edge,
      relation: input.relation,
      confidence: input.confidence ?? edge.confidence,
      rationale: input.rationale ?? edge.rationale,
      updatedAt: nextUpdatedAt(edge.updatedAt),
    };
    this.evolvesById.set(updated.id, updated);
    this.appendJsonLine(this.evolvesPath, updated);
    return true;
  }

  getState(): MemoryStoreState {
    this.ensureStateLoaded();
    return {
      ...this.state,
      dirtyEntries: this.state.dirtyEntries.map((entry) => ({ ...entry })),
    };
  }

  setState(next: MemoryStoreState): void {
    this.state = {
      schemaVersion: MEMORY_STATE_SCHEMA_VERSION,
      lastPublishedAt: next.lastPublishedAt ?? null,
      lastPublishedDayKey: next.lastPublishedDayKey ?? null,
      dirtyEntries: normalizeDirtyEntries(next.dirtyEntries),
    };
    this.stateLoaded = true;
    writeFileAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  mergeDirtyTopics(topics: string[], options: { reason: MemoryDirtyReason }): MemoryStoreState {
    const current = this.getState();
    const dirtyEntries = [...current.dirtyEntries];
    const updatedAt = Date.now();
    for (const topic of topics) {
      const normalized = topic.trim();
      if (!normalized) continue;
      dirtyEntries.push({
        topic: normalized,
        reason: options.reason,
        updatedAt,
      });
    }
    const next: MemoryStoreState = {
      ...current,
      dirtyEntries,
    };
    this.setState(next);
    return this.getState();
  }

  markPublished(input: {
    at: number;
    dayKey: string;
    clearDirtyEntries?: boolean;
  }): MemoryStoreState {
    const current = this.getState();
    const next: MemoryStoreState = {
      ...current,
      lastPublishedAt: input.at,
      lastPublishedDayKey: input.dayKey,
      dirtyEntries: input.clearDirtyEntries === false ? current.dirtyEntries : [],
    };
    this.setState(next);
    this.maybeCompactIfNeeded();
    return this.getState();
  }

  publishWorking(snapshot: WorkingMemorySnapshot, maxChars: number): void {
    const text = maxChars > 0 ? snapshot.content.slice(0, maxChars) : "";
    const normalizedText = text.trim().length > 0 ? `${text.trimEnd()}\n` : "";
    writeFileAtomic(this.workingPath, normalizedText);
    this.workingBySession.set(snapshot.sessionId, {
      ...snapshot,
      content: normalizedText.trimEnd(),
    });
  }

  importWorkingSnapshot(snapshot: WorkingMemorySnapshot, maxChars: number): void {
    if (
      !snapshot ||
      typeof snapshot.sessionId !== "string" ||
      typeof snapshot.generatedAt !== "number" ||
      !Number.isFinite(snapshot.generatedAt) ||
      typeof snapshot.content !== "string"
    ) {
      return;
    }
    this.publishWorking(snapshot, maxChars);
  }

  getWorkingSnapshot(sessionId: string): WorkingMemorySnapshot | undefined {
    return this.workingBySession.get(sessionId);
  }

  getWorkingText(): string {
    if (!existsSync(this.workingPath)) return "";
    try {
      return readFileSync(this.workingPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  dismissInsight(insightId: string): MemoryInsight | undefined {
    this.ensureInsightsLoaded();
    const insight = this.insightsById.get(insightId);
    if (!insight || insight.status !== "open") return undefined;
    const updatedAt = nextUpdatedAt(insight.updatedAt);
    const updated: MemoryInsight = {
      ...insight,
      status: "dismissed",
      updatedAt,
    };
    this.insightsById.set(updated.id, updated);
    this.appendJsonLine(this.insightsPath, updated);
    return updated;
  }

  withRefreshLock<T>(fn: () => T): { acquired: true; value: T } | { acquired: false } {
    let fd: number | null = null;
    try {
      fd = openSync(this.refreshLockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stats = statSync(this.refreshLockPath);
        const ageMs = differenceInMilliseconds(Date.now(), stats.mtimeMs);
        if (ageMs > REFRESH_LOCK_STALE_MS) {
          unlinkSync(this.refreshLockPath);
          fd = openSync(this.refreshLockPath, "wx");
        } else {
          return { acquired: false };
        }
      } catch {
        return { acquired: false };
      }
    }
    try {
      return { acquired: true, value: fn() };
    } finally {
      try {
        if (fd !== null) closeSync(fd);
      } catch {}
      try {
        unlinkSync(this.refreshLockPath);
      } catch {}
    }
  }

  compact(): void {
    this.compactFile(this.unitsPath, this.unitsById, this.unitsLoaded);
    this.compactFile(this.crystalsPath, this.crystalsById, this.crystalsLoaded);
    this.compactFile(this.insightsPath, this.insightsById, this.insightsLoaded);
    this.compactFile(this.evolvesPath, this.evolvesById, this.evolvesLoaded);
    this.unitsLineCount = this.unitsById.size;
    this.crystalsLineCount = this.crystalsById.size;
    this.insightsLineCount = this.insightsById.size;
    this.evolvesLineCount = this.evolvesById.size;
  }

  clearSessionCache(sessionId: string): void {
    this.workingBySession.delete(sessionId);
  }

  private compactFile<T extends { id: string }>(
    path: string,
    index: Map<string, T>,
    loaded: boolean,
  ): void {
    if (!loaded) return;
    if (index.size === 0) {
      writeFileAtomic(path, "");
      return;
    }
    const lines = [...index.values()].map((item) => JSON.stringify(item));
    writeFileAtomic(path, `${lines.join("\n")}\n`);
  }

  private ensureUnitsLoaded(): void {
    if (this.unitsLoaded) return;
    const rows = parseJsonLines<MemoryUnit>(this.unitsPath);
    let maxUnitAt = 0;
    this.unitsById.clear();
    this.unitIdBySessionFingerprint.clear();
    for (const row of rows) {
      if (!row || typeof row.id !== "string") continue;
      if (isTombstoneRow(row)) {
        this.unitsById.delete(row.id);
        continue;
      }
      if (typeof row.sessionId !== "string") continue;
      if (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)) {
        maxUnitAt = Math.max(maxUnitAt, row.updatedAt);
      }
      const existing = this.unitsById.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        this.unitsById.set(row.id, row);
      }
    }
    for (const unit of this.unitsById.values()) {
      this.unitIdBySessionFingerprint.set(`${unit.sessionId}:${unit.fingerprint}`, unit.id);
    }
    this.unitsLineCount = rows.length;
    this.unitWriteAt = Math.max(this.unitWriteAt, maxUnitAt);
    this.unitsLoaded = true;
  }

  private ensureCrystalsLoaded(): void {
    if (this.crystalsLoaded) return;
    const rows = parseJsonLines<MemoryCrystal>(this.crystalsPath);
    this.crystalsById.clear();
    this.crystalIdBySessionTopic.clear();
    for (const row of rows) {
      if (!row || typeof row.id !== "string") continue;
      if (isTombstoneRow(row)) {
        this.crystalsById.delete(row.id);
        continue;
      }
      if (typeof row.sessionId !== "string") continue;
      const existing = this.crystalsById.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        this.crystalsById.set(row.id, row);
      }
    }
    for (const crystal of this.crystalsById.values()) {
      this.crystalIdBySessionTopic.set(
        `${crystal.sessionId}:${normalizeText(crystal.topic)}`,
        crystal.id,
      );
    }
    this.crystalsLineCount = rows.length;
    this.crystalsLoaded = true;
  }

  private ensureInsightsLoaded(): void {
    if (this.insightsLoaded) return;
    const rows = parseJsonLines<MemoryInsight>(this.insightsPath);
    this.insightsById.clear();
    for (const row of rows) {
      if (!row || typeof row.id !== "string") continue;
      const existing = this.insightsById.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        this.insightsById.set(row.id, row);
      }
    }
    this.insightsLineCount = rows.length;
    this.insightsLoaded = true;
  }

  private ensureEvolvesLoaded(): void {
    if (this.evolvesLoaded) return;
    const rows = parseJsonLines<MemoryEvolvesEdge>(this.evolvesPath);
    this.evolvesById.clear();
    for (const row of rows) {
      if (!row || typeof row.id !== "string") continue;
      const existing = this.evolvesById.get(row.id);
      if (!existing || row.updatedAt >= existing.updatedAt) {
        this.evolvesById.set(row.id, row);
      }
    }
    this.evolvesLineCount = rows.length;
    this.evolvesLoaded = true;
  }

  private ensureStateLoaded(): void {
    if (this.stateLoaded) return;
    if (!existsSync(this.statePath)) {
      this.state = defaultState();
      this.stateLoaded = true;
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<MemoryStoreState>;
      const dirtyEntries = Array.isArray(raw.dirtyEntries)
        ? raw.dirtyEntries
            .map((entry) => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
              const row = entry as Partial<MemoryDirtyEntry>;
              const reason = normalizeDirtyReason(row.reason);
              if (!reason) return null;
              if (typeof row.topic !== "string") return null;
              return {
                topic: row.topic,
                reason,
                updatedAt:
                  typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
                    ? row.updatedAt
                    : Date.now(),
              } satisfies MemoryDirtyEntry;
            })
            .filter((entry): entry is MemoryDirtyEntry => entry !== null)
        : [];
      this.state = {
        schemaVersion: MEMORY_STATE_SCHEMA_VERSION,
        lastPublishedAt:
          typeof raw.lastPublishedAt === "number" && Number.isFinite(raw.lastPublishedAt)
            ? raw.lastPublishedAt
            : null,
        lastPublishedDayKey:
          typeof raw.lastPublishedDayKey === "string" && raw.lastPublishedDayKey.trim()
            ? raw.lastPublishedDayKey
            : null,
        dirtyEntries: normalizeDirtyEntries(dirtyEntries),
      };
    } catch {
      this.state = defaultState();
    }
    this.stateLoaded = true;
  }

  private appendJsonLine(path: string, value: unknown): void {
    writeFileSync(path, `\n${JSON.stringify(value)}`, { flag: "a" });
    if (path === this.unitsPath) {
      this.unitsLineCount += 1;
    } else if (path === this.crystalsPath) {
      this.crystalsLineCount += 1;
    } else if (path === this.insightsPath) {
      this.insightsLineCount += 1;
    } else if (path === this.evolvesPath) {
      this.evolvesLineCount += 1;
    }
    this.maybeCompactIfNeeded();
  }

  private maybeCompactIfNeeded(): void {
    if (
      this.unitsLineCount <= COMPACTION_LINE_THRESHOLD &&
      this.crystalsLineCount <= COMPACTION_LINE_THRESHOLD &&
      this.insightsLineCount <= COMPACTION_LINE_THRESHOLD &&
      this.evolvesLineCount <= COMPACTION_LINE_THRESHOLD
    ) {
      return;
    }
    this.compact();
  }

  private nextUnitWriteAt(proposedAt: number): number {
    const next = nextUpdatedAt(this.unitWriteAt, proposedAt);
    this.unitWriteAt = next;
    return next;
  }
}
