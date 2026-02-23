import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import type { JsonValue } from "../utils/json.js";
import { readGlobalLessonProtocol } from "./global-protocol.js";
import { MemoryStore } from "./store.js";
import {
  GLOBAL_CRYSTAL_PROTOCOL_SCHEMA,
  GLOBAL_LESSON_PROTOCOL_SCHEMA,
  type MemoryCrystal,
  type MemoryGlobalCrystalProtocol,
  type MemoryGlobalLessonProtocol,
  type MemorySourceRef,
  type MemoryUnit,
} from "./types.js";
import { mergeSourceRefs, normalizeText } from "./utils.js";

const GLOBAL_DECAY_SCHEMA_VERSION = 1;
const GLOBAL_MEMORY_SNAPSHOT_SCHEMA = "brewva.memory.global.v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const GLOBAL_CRYSTAL_MIN_UNITS = 2;

export const GLOBAL_MEMORY_SESSION_ID = "__global__";

interface GlobalDecayState {
  schemaVersion: number;
  lastDecayAt: number | null;
}

interface UnitAggregate {
  exemplar: MemoryUnit;
  sessionIds: Set<string>;
  units: MemoryUnit[];
}

function defaultDecayState(): GlobalDecayState {
  return {
    schemaVersion: GLOBAL_DECAY_SCHEMA_VERSION,
    lastDecayAt: null,
  };
}

function clampUnitInterval(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readMetadataString(
  metadata: MemoryUnit["metadata"] | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readMetadataStringArray(
  metadata: MemoryUnit["metadata"] | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out.add(trimmed);
  }
  return [...out];
}

function rankStringValues(entries: Array<{ value: string; updatedAt: number }>): string[] {
  const ranked = new Map<
    string,
    {
      value: string;
      count: number;
      updatedAt: number;
    }
  >();
  for (const entry of entries) {
    const normalized = normalizeText(entry.value);
    if (!normalized) continue;
    const current = ranked.get(normalized);
    if (!current) {
      ranked.set(normalized, {
        value: entry.value,
        count: 1,
        updatedAt: entry.updatedAt,
      });
      continue;
    }
    current.count += 1;
    if (entry.updatedAt >= current.updatedAt) {
      current.updatedAt = entry.updatedAt;
      current.value = entry.value;
    }
  }

  return [...ranked.values()]
    .toSorted((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
      return left.value.localeCompare(right.value);
    })
    .map((entry) => entry.value);
}

function readLessonKey(unit: MemoryUnit): string | null {
  if (unit.type !== "learning") return null;
  return readMetadataString(unit.metadata, "lessonKey");
}

function readLessonOutcome(unit: MemoryUnit): "pass" | "fail" | null {
  if (unit.type !== "learning") return null;
  const outcome = readMetadataString(unit.metadata, "lessonOutcome");
  return outcome === "pass" || outcome === "fail" ? outcome : null;
}

function readLessonStructuredFields(unit: MemoryUnit): {
  lessonKeyValues: string[];
  patternValues: string[];
  rootCauseValues: string[];
  recommendationValues: string[];
  sourceSessionIds: string[];
  outcome: "pass" | "fail" | null;
  protocolOutcomes: { pass: number; fail: number };
} {
  const protocol = readGlobalLessonProtocol(unit.metadata);
  const lessonKeyValues = uniqueStrings([
    readLessonKey(unit),
    readMetadataString(unit.metadata, "lessonKey"),
    protocol?.lessonKey,
  ]);
  const patternValues = uniqueStrings([
    readMetadataString(unit.metadata, "pattern"),
    ...readMetadataStringArray(unit.metadata, "patterns"),
    protocol?.pattern,
    ...(protocol?.patterns ?? []),
  ]);
  const rootCauseValues = uniqueStrings([
    readMetadataString(unit.metadata, "rootCause"),
    ...readMetadataStringArray(unit.metadata, "rootCauses"),
    protocol?.rootCause,
    ...(protocol?.rootCauses ?? []),
  ]);
  const recommendationValues = uniqueStrings([
    readMetadataString(unit.metadata, "recommendation"),
    readMetadataString(unit.metadata, "adjustedStrategy"),
    ...readMetadataStringArray(unit.metadata, "recommendations"),
    protocol?.recommendation,
    ...(protocol?.recommendations ?? []),
  ]);
  const sourceSessionIds = uniqueStrings([
    ...readMetadataStringArray(unit.metadata, "sourceSessionIds"),
    ...(protocol?.sourceSessionIds ?? []),
  ]);
  return {
    lessonKeyValues,
    patternValues,
    rootCauseValues,
    recommendationValues,
    sourceSessionIds,
    outcome: readLessonOutcome(unit),
    protocolOutcomes: {
      pass: protocol?.outcomes.pass ?? 0,
      fail: protocol?.outcomes.fail ?? 0,
    },
  };
}

function promotionKeyForUnit(unit: MemoryUnit): string {
  const lessonKey = readLessonKey(unit);
  if (lessonKey) {
    return `lesson:${normalizeText(lessonKey)}`;
  }
  return `fingerprint:${unit.fingerprint}`;
}

function collectConfirmedPassLessonKeys(units: MemoryUnit[]): Set<string> {
  const keys = new Set<string>();
  for (const unit of units) {
    const lessonKey = readLessonKey(unit);
    if (!lessonKey) continue;
    if (readLessonOutcome(unit) !== "pass") continue;
    keys.add(normalizeText(lessonKey));
  }
  return keys;
}

function toJsonMetadata(input: Record<string, unknown>): Record<string, JsonValue> {
  return input as Record<string, JsonValue>;
}

function toSnapshotUnit(value: unknown): MemoryUnit | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.fingerprint !== "string") return null;
  if (typeof value.topic !== "string") return null;
  if (typeof value.statement !== "string") return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
  if (typeof value.lastSeenAt !== "number" || !Number.isFinite(value.lastSeenAt)) return null;

  const row = value as unknown as MemoryUnit;
  return {
    ...row,
    sessionId: GLOBAL_MEMORY_SESSION_ID,
  };
}

function toSnapshotCrystal(value: unknown): MemoryCrystal | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.topic !== "string") return null;
  if (typeof value.summary !== "string") return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;

  const row = value as unknown as MemoryCrystal;
  return {
    ...row,
    sessionId: GLOBAL_MEMORY_SESSION_ID,
  };
}

function summarizeGlobalUnits(input: {
  pattern: string | null;
  rootCause: string | null;
  rootCauses: string[];
  recommendation: string | null;
  recommendations: string[];
  outcomes: { pass: number; fail: number };
  units: MemoryUnit[];
}): string {
  const ranked = input.units
    .toSorted((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return right.lastSeenAt - left.lastSeenAt;
    })
    .slice(0, 3);

  const lines = ["[GlobalCrystal]"];
  if (input.pattern) {
    lines.push(`- pattern: ${input.pattern}`);
  }
  if (input.outcomes.pass > 0 || input.outcomes.fail > 0) {
    lines.push(`- outcomes: pass=${input.outcomes.pass}; fail=${input.outcomes.fail}`);
  }
  if (input.rootCause) {
    lines.push(`- root_cause: ${input.rootCause}`);
  } else if (input.rootCauses.length > 0) {
    lines.push(`- root_causes: ${input.rootCauses.slice(0, 3).join(" | ")}`);
  }
  if (input.recommendation) {
    lines.push(`- recommendation: ${input.recommendation}`);
  } else if (input.recommendations.length > 0) {
    lines.push(`- recommendations: ${input.recommendations.slice(0, 3).join(" | ")}`);
  }
  for (const unit of ranked) {
    lines.push(`- ${unit.statement}`);
  }
  return lines.join("\n");
}

function buildGlobalCrystalProtocol(input: {
  pattern: string | null;
  patterns: string[];
  rootCause: string | null;
  rootCauses: string[];
  recommendation: string | null;
  recommendations: string[];
  lessonKeys: string[];
  outcomes: { pass: number; fail: number };
  sourceSessionIds: string[];
  unitCount: number;
  updatedAt: number;
}): MemoryGlobalCrystalProtocol {
  return {
    schema: GLOBAL_CRYSTAL_PROTOCOL_SCHEMA,
    version: 1,
    pattern: input.pattern,
    patterns: input.patterns,
    rootCause: input.rootCause,
    rootCauses: input.rootCauses,
    recommendation: input.recommendation,
    recommendations: input.recommendations,
    lessonKeys: input.lessonKeys,
    outcomes: {
      pass: input.outcomes.pass,
      fail: input.outcomes.fail,
    },
    sourceSessionIds: input.sourceSessionIds,
    sourceSessionCount: input.sourceSessionIds.length,
    unitCount: input.unitCount,
    updatedAt: input.updatedAt,
  };
}

function buildGlobalLessonProtocol(input: {
  lessonKey: string | null;
  pattern: string | null;
  patterns: string[];
  rootCause: string | null;
  rootCauses: string[];
  recommendation: string | null;
  recommendations: string[];
  outcomes: { pass: number; fail: number };
  sourceSessionIds: string[];
  updatedAt: number;
}): MemoryGlobalLessonProtocol {
  return {
    schema: GLOBAL_LESSON_PROTOCOL_SCHEMA,
    version: 1,
    lessonKey: input.lessonKey,
    pattern: input.pattern,
    patterns: input.patterns,
    rootCause: input.rootCause,
    rootCauses: input.rootCauses,
    recommendation: input.recommendation,
    recommendations: input.recommendations,
    outcomes: {
      pass: input.outcomes.pass,
      fail: input.outcomes.fail,
    },
    sourceSessionIds: input.sourceSessionIds,
    sourceSessionCount: input.sourceSessionIds.length,
    updatedAt: input.updatedAt,
  };
}

function mergeUnitSourceRefs(units: MemoryUnit[]): MemorySourceRef[] {
  return units.reduce(
    (merged, unit) => mergeSourceRefs(merged, unit.sourceRefs),
    [] as MemorySourceRef[],
  );
}

export interface GlobalMemoryTierOptions {
  rootDir: string;
  promotionMinConfidence: number;
  promotionMinSessionRecurrence: number;
  decayIntervalDays: number;
  decayFactor: number;
  pruneBelowConfidence: number;
}

export interface GlobalMemorySnapshot {
  schema: typeof GLOBAL_MEMORY_SNAPSHOT_SCHEMA;
  generatedAt: number;
  units: MemoryUnit[];
  crystals: MemoryCrystal[];
}

export interface GlobalMemoryLifecycleResult {
  scannedCandidates: number;
  promoted: number;
  refreshed: number;
  decayed: number;
  pruned: number;
  resolvedByPass: number;
  crystalsCompiled: number;
  crystalsRemoved: number;
  promotedUnitIds: string[];
}

export class GlobalMemoryTier {
  private readonly rootDir: string;
  private readonly decayStatePath: string;
  private readonly store: MemoryStore;
  private readonly promotionMinConfidence: number;
  private readonly promotionMinSessionRecurrence: number;
  private readonly decayIntervalDays: number;
  private readonly decayFactor: number;
  private readonly pruneBelowConfidence: number;

  private decayStateLoaded = false;
  private decayState: GlobalDecayState = defaultDecayState();

  constructor(options: GlobalMemoryTierOptions) {
    this.rootDir = resolve(options.rootDir);
    ensureDir(this.rootDir);
    this.decayStatePath = join(this.rootDir, "global-decay.json");
    this.store = new MemoryStore({
      rootDir: this.rootDir,
      workingFile: "global-working.md",
    });
    this.promotionMinConfidence = clampUnitInterval(options.promotionMinConfidence, 0.8);
    this.promotionMinSessionRecurrence = Math.max(
      2,
      Math.floor(options.promotionMinSessionRecurrence),
    );
    this.decayIntervalDays = Math.max(1, Math.floor(options.decayIntervalDays));
    this.decayFactor = clampUnitInterval(options.decayFactor, 0.95);
    this.pruneBelowConfidence = clampUnitInterval(options.pruneBelowConfidence, 0.3);
  }

  listUnits(): MemoryUnit[] {
    return this.store
      .listUnits(GLOBAL_MEMORY_SESSION_ID)
      .filter((unit) => unit.status === "active")
      .toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  listCrystals(): MemoryCrystal[] {
    return this.store
      .listCrystals(GLOBAL_MEMORY_SESSION_ID)
      .toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  snapshot(now = Date.now()): GlobalMemorySnapshot {
    return {
      schema: GLOBAL_MEMORY_SNAPSHOT_SCHEMA,
      generatedAt: now,
      units: this.listUnits(),
      crystals: this.listCrystals(),
    };
  }

  importSnapshot(snapshot: unknown): {
    importedUnits: number;
    importedCrystals: number;
    removedUnits: number;
    removedCrystals: number;
  } {
    if (!isRecord(snapshot) || snapshot.schema !== GLOBAL_MEMORY_SNAPSHOT_SCHEMA) {
      return {
        importedUnits: 0,
        importedCrystals: 0,
        removedUnits: 0,
        removedCrystals: 0,
      };
    }

    const units = Array.isArray(snapshot.units)
      ? snapshot.units
          .map((row) => toSnapshotUnit(row))
          .filter((row): row is MemoryUnit => row !== null)
      : [];
    const crystals = Array.isArray(snapshot.crystals)
      ? snapshot.crystals
          .map((row) => toSnapshotCrystal(row))
          .filter((row): row is MemoryCrystal => row !== null)
      : [];

    const unitIds = new Set(units.map((unit) => unit.id));
    const crystalIds = new Set(crystals.map((crystal) => crystal.id));

    let removedUnits = 0;
    let removedCrystals = 0;
    for (const existing of this.store.listUnits(GLOBAL_MEMORY_SESSION_ID)) {
      if (unitIds.has(existing.id)) continue;
      if (this.store.removeUnit(existing.id)) {
        removedUnits += 1;
      }
    }
    for (const existing of this.store.listCrystals(GLOBAL_MEMORY_SESSION_ID)) {
      if (crystalIds.has(existing.id)) continue;
      if (this.store.removeCrystal(existing.id)) {
        removedCrystals += 1;
      }
    }

    let importedUnits = 0;
    let importedCrystals = 0;
    for (const unit of units) {
      const imported = this.store.importUnitSnapshot(unit);
      if (imported.applied) importedUnits += 1;
    }
    for (const crystal of crystals) {
      const imported = this.store.importCrystalSnapshot(crystal);
      if (imported.applied) importedCrystals += 1;
    }

    return {
      importedUnits,
      importedCrystals,
      removedUnits,
      removedCrystals,
    };
  }

  runLifecycle(input: {
    sessionId: string;
    sessionUnits: MemoryUnit[];
    allUnits: MemoryUnit[];
    now?: number;
  }): GlobalMemoryLifecycleResult {
    const now = input.now ?? Date.now();
    const decay = this.applyDecay(now);

    const aggregates = this.buildAggregates(input.allUnits);
    const passLessonKeys = collectConfirmedPassLessonKeys(input.allUnits);
    const globalUnits = this.store.listUnits(GLOBAL_MEMORY_SESSION_ID);
    const globalByPromotionKey = new Map(
      globalUnits.map((unit) => [promotionKeyForUnit(unit), unit]),
    );

    let removedByPass = 0;
    for (const unit of globalUnits) {
      const lessonKey = readLessonKey(unit);
      if (!lessonKey) continue;
      if (readLessonOutcome(unit) !== "fail") continue;
      if (!passLessonKeys.has(normalizeText(lessonKey))) continue;
      if (this.store.removeUnit(unit.id)) {
        removedByPass += 1;
        globalByPromotionKey.delete(promotionKeyForUnit(unit));
      }
    }

    const seenPromotionKeys = new Set<string>();
    let scannedCandidates = 0;
    let promoted = 0;
    let refreshed = 0;
    const promotedUnitIds: string[] = [];

    for (const unit of input.sessionUnits) {
      if (!this.isPromotionEligible(unit)) continue;
      const promotionKey = promotionKeyForUnit(unit);
      if (seenPromotionKeys.has(promotionKey)) continue;
      seenPromotionKeys.add(promotionKey);

      const lessonKey = readLessonKey(unit);
      if (
        lessonKey &&
        readLessonOutcome(unit) === "fail" &&
        passLessonKeys.has(normalizeText(lessonKey))
      ) {
        continue;
      }

      scannedCandidates += 1;

      const aggregate = aggregates.get(promotionKey);
      if (!aggregate) continue;
      if (aggregate.sessionIds.size < this.promotionMinSessionRecurrence) continue;
      const aggregateLessonKey = readLessonKey(aggregate.exemplar);
      if (
        aggregateLessonKey &&
        readLessonOutcome(aggregate.exemplar) === "fail" &&
        passLessonKeys.has(normalizeText(aggregateLessonKey))
      ) {
        continue;
      }

      let existing = globalByPromotionKey.get(promotionKey);
      if (existing && existing.status !== "active") {
        this.store.removeUnit(existing.id);
        globalByPromotionKey.delete(promotionKey);
        existing = undefined;
      }

      if (
        existing &&
        aggregateLessonKey &&
        readLessonKey(existing) &&
        !promotionKey.startsWith("lesson:") &&
        existing.fingerprint !== aggregate.exemplar.fingerprint
      ) {
        this.store.removeUnit(existing.id);
        globalByPromotionKey.delete(promotionKey);
        existing = undefined;
      }

      const sourceSessionIds = [
        ...new Set([
          ...readMetadataStringArray(existing?.metadata, "sourceSessionIds"),
          ...aggregate.sessionIds,
        ]),
      ].toSorted();
      const lessonFields = this.aggregateLessonFields({
        aggregate,
        existing,
        lessonKeyHint: aggregateLessonKey,
      });
      const lessonOutcome =
        lessonFields.outcomes.pass > 0
          ? "pass"
          : lessonFields.outcomes.fail > 0
            ? "fail"
            : readLessonOutcome(aggregate.exemplar);
      const globalLesson =
        lessonFields.lessonKey ||
        lessonFields.patterns.length > 0 ||
        lessonFields.rootCauses.length > 0 ||
        lessonFields.recommendations.length > 0
          ? buildGlobalLessonProtocol({
              lessonKey: lessonFields.lessonKey,
              pattern: lessonFields.pattern,
              patterns: lessonFields.patterns,
              rootCause: lessonFields.rootCause,
              rootCauses: lessonFields.rootCauses,
              recommendation: lessonFields.recommendation,
              recommendations: lessonFields.recommendations,
              outcomes: lessonFields.outcomes,
              sourceSessionIds,
              updatedAt: now,
            })
          : null;
      const metadata = toJsonMetadata({
        ...(isRecord(existing?.metadata) ? existing?.metadata : {}),
        ...(isRecord(aggregate.exemplar.metadata) ? aggregate.exemplar.metadata : {}),
        memoryTier: "global",
        sourceSessionIds,
        recurrence: sourceSessionIds.length,
        originalFingerprint: aggregate.exemplar.fingerprint,
        lastConfirmedAt: now,
        promotedBySessionId: input.sessionId,
        ...(lessonFields.lessonKey ? { lessonKey: lessonFields.lessonKey } : {}),
        ...(lessonOutcome ? { lessonOutcome } : {}),
        ...(lessonFields.pattern ? { pattern: lessonFields.pattern } : {}),
        ...(lessonFields.patterns.length > 0 ? { patterns: lessonFields.patterns } : {}),
        ...(lessonFields.rootCause ? { rootCause: lessonFields.rootCause } : {}),
        ...(lessonFields.rootCauses.length > 0 ? { rootCauses: lessonFields.rootCauses } : {}),
        ...(lessonFields.recommendation ? { recommendation: lessonFields.recommendation } : {}),
        ...(lessonFields.recommendations.length > 0
          ? { recommendations: lessonFields.recommendations }
          : {}),
        ...(globalLesson ? { globalLesson: globalLesson as unknown as JsonValue } : {}),
      });

      const upserted = this.store.upsertUnit({
        sessionId: GLOBAL_MEMORY_SESSION_ID,
        type: aggregate.exemplar.type,
        status: "active",
        topic: aggregate.exemplar.topic,
        statement: aggregate.exemplar.statement,
        confidence: 1,
        metadata,
        sourceRefs: aggregate.exemplar.sourceRefs,
      });
      globalByPromotionKey.set(promotionKey, upserted.unit);
      promotedUnitIds.push(upserted.unit.id);
      if (upserted.created) promoted += 1;
      else refreshed += 1;
    }

    const crystals = this.reconcileCrystals();
    return {
      scannedCandidates,
      promoted,
      refreshed,
      decayed: decay.decayed,
      pruned: decay.pruned,
      resolvedByPass: removedByPass,
      crystalsCompiled: crystals.compiled,
      crystalsRemoved: crystals.removed,
      promotedUnitIds,
    };
  }

  private isPromotionEligible(unit: MemoryUnit): boolean {
    if (unit.type === "risk") return false;
    if (unit.confidence < this.promotionMinConfidence) return false;
    if (unit.status === "active") return true;
    if (unit.type !== "learning") return false;
    if (unit.status !== "resolved") return false;
    return readMetadataString(unit.metadata, "lessonOutcome") === "pass";
  }

  private buildAggregates(units: MemoryUnit[]): Map<string, UnitAggregate> {
    const aggregates = new Map<string, UnitAggregate>();
    for (const unit of units) {
      if (!this.isPromotionEligible(unit)) continue;
      const key = promotionKeyForUnit(unit);
      const current = aggregates.get(key);
      if (!current) {
        aggregates.set(key, {
          exemplar: unit,
          sessionIds: new Set([unit.sessionId]),
          units: [unit],
        });
        continue;
      }
      current.sessionIds.add(unit.sessionId);
      current.units.push(unit);
      if (unit.updatedAt > current.exemplar.updatedAt) {
        current.exemplar = unit;
      }
    }
    return aggregates;
  }

  private aggregateLessonFields(input: {
    aggregate: UnitAggregate;
    existing?: MemoryUnit;
    lessonKeyHint: string | null;
  }): {
    lessonKey: string | null;
    pattern: string | null;
    patterns: string[];
    rootCause: string | null;
    rootCauses: string[];
    recommendation: string | null;
    recommendations: string[];
    outcomes: { pass: number; fail: number };
  } {
    const lessonKeyCandidates: Array<{ value: string; updatedAt: number }> = [];
    const patternCandidates: Array<{ value: string; updatedAt: number }> = [];
    const rootCauseCandidates: Array<{ value: string; updatedAt: number }> = [];
    const recommendationCandidates: Array<{ value: string; updatedAt: number }> = [];
    let aggregatePassCount = 0;
    let aggregateFailCount = 0;
    let existingProtocolPassCount = 0;
    let existingProtocolFailCount = 0;

    for (const unit of input.aggregate.units) {
      const structured = readLessonStructuredFields(unit);
      for (const value of structured.lessonKeyValues) {
        lessonKeyCandidates.push({ value, updatedAt: unit.updatedAt });
      }
      for (const value of structured.patternValues) {
        patternCandidates.push({ value, updatedAt: unit.updatedAt });
      }
      for (const value of structured.rootCauseValues) {
        rootCauseCandidates.push({ value, updatedAt: unit.updatedAt });
      }
      for (const value of structured.recommendationValues) {
        recommendationCandidates.push({ value, updatedAt: unit.updatedAt });
      }
      if (structured.outcome === "pass") aggregatePassCount += 1;
      if (structured.outcome === "fail") aggregateFailCount += 1;
    }

    if (input.existing) {
      const structured = readLessonStructuredFields(input.existing);
      for (const value of structured.lessonKeyValues) {
        lessonKeyCandidates.push({ value, updatedAt: input.existing.updatedAt });
      }
      for (const value of structured.patternValues) {
        patternCandidates.push({ value, updatedAt: input.existing.updatedAt });
      }
      for (const value of structured.rootCauseValues) {
        rootCauseCandidates.push({ value, updatedAt: input.existing.updatedAt });
      }
      for (const value of structured.recommendationValues) {
        recommendationCandidates.push({ value, updatedAt: input.existing.updatedAt });
      }
      existingProtocolPassCount = Math.max(0, structured.protocolOutcomes.pass);
      existingProtocolFailCount = Math.max(0, structured.protocolOutcomes.fail);
    }
    if (input.lessonKeyHint) {
      lessonKeyCandidates.push({
        value: input.lessonKeyHint,
        updatedAt: input.aggregate.exemplar.updatedAt,
      });
    }

    const rankedLessonKeys = rankStringValues(lessonKeyCandidates);
    const rankedPatterns = rankStringValues(patternCandidates);
    const rankedRootCauses = rankStringValues(rootCauseCandidates);
    const rankedRecommendations = rankStringValues(recommendationCandidates);

    return {
      lessonKey: rankedLessonKeys[0] ?? input.lessonKeyHint ?? null,
      pattern: rankedPatterns[0] ?? null,
      patterns: rankedPatterns,
      rootCause: rankedRootCauses[0] ?? null,
      rootCauses: rankedRootCauses,
      recommendation: rankedRecommendations[0] ?? null,
      recommendations: rankedRecommendations,
      outcomes: {
        // Avoid compounding historical counts on each lifecycle run.
        // Aggregate counts come from current session-level evidence; existing protocol values are treated as floor.
        pass: Math.max(aggregatePassCount, existingProtocolPassCount),
        fail: Math.max(aggregateFailCount, existingProtocolFailCount),
      },
    };
  }

  private applyDecay(now: number): { decayed: number; pruned: number } {
    const intervalMs = this.decayIntervalDays * DAY_MS;
    const state = this.getDecayState();
    if (state.lastDecayAt === null) {
      this.setDecayState({
        schemaVersion: GLOBAL_DECAY_SCHEMA_VERSION,
        lastDecayAt: now,
      });
      return { decayed: 0, pruned: 0 };
    }

    const elapsedMs = Math.max(0, now - state.lastDecayAt);
    const cycles = Math.floor(elapsedMs / intervalMs);
    if (cycles <= 0) return { decayed: 0, pruned: 0 };

    const multiplier = Math.pow(this.decayFactor, cycles);
    let decayed = 0;
    let pruned = 0;

    for (const unit of this.store.listUnits(GLOBAL_MEMORY_SESSION_ID)) {
      if (unit.status !== "active") continue;
      const nextConfidence = clampUnitInterval(unit.confidence * multiplier, unit.confidence);
      if (nextConfidence < this.pruneBelowConfidence) {
        if (this.store.removeUnit(unit.id)) {
          pruned += 1;
        }
        continue;
      }
      if (nextConfidence >= unit.confidence) continue;
      this.store.updateUnitConfidence({
        sessionId: GLOBAL_MEMORY_SESSION_ID,
        unitId: unit.id,
        confidence: nextConfidence,
        updatedAt: now,
        metadata: toJsonMetadata({
          ...(isRecord(unit.metadata) ? unit.metadata : {}),
          lastDecayedAt: now,
          decayCyclesApplied: cycles,
        }),
      });
      decayed += 1;
    }

    this.setDecayState({
      schemaVersion: GLOBAL_DECAY_SCHEMA_VERSION,
      lastDecayAt: state.lastDecayAt + cycles * intervalMs,
    });
    return { decayed, pruned };
  }

  private reconcileCrystals(): { compiled: number; removed: number } {
    const grouped = new Map<string, { pattern: string | null; units: MemoryUnit[] }>();
    for (const unit of this.listUnits()) {
      const structured = readLessonStructuredFields(unit);
      const pattern = structured.patternValues[0] ?? readMetadataString(unit.metadata, "pattern");
      const key = pattern
        ? `pattern:${normalizeText(pattern)}`
        : `topic:${normalizeText(unit.topic)}`;
      if (!key || key.endsWith(":")) continue;
      const bucket = grouped.get(key) ?? { pattern, units: [] };
      bucket.units.push(unit);
      if (!bucket.pattern && pattern) bucket.pattern = pattern;
      grouped.set(key, bucket);
    }

    const desiredTopicKeys = new Set<string>();
    let compiled = 0;
    for (const { pattern, units } of grouped.values()) {
      if (units.length < GLOBAL_CRYSTAL_MIN_UNITS) continue;
      const sorted = units.toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);
      const latest = sorted[0];
      if (!latest) continue;

      const patternCandidates: Array<{ value: string; updatedAt: number }> = [];
      const rootCauseCandidates: Array<{ value: string; updatedAt: number }> = [];
      const recommendationCandidates: Array<{ value: string; updatedAt: number }> = [];
      const lessonKeyCandidates: Array<{ value: string; updatedAt: number }> = [];
      let passCount = 0;
      let failCount = 0;
      if (pattern) {
        patternCandidates.push({
          value: pattern,
          updatedAt: latest.updatedAt,
        });
      }
      for (const unit of sorted) {
        const structured = readLessonStructuredFields(unit);
        for (const value of structured.patternValues) {
          patternCandidates.push({ value, updatedAt: unit.updatedAt });
        }
        for (const value of structured.rootCauseValues) {
          rootCauseCandidates.push({ value, updatedAt: unit.updatedAt });
        }
        for (const value of structured.recommendationValues) {
          recommendationCandidates.push({ value, updatedAt: unit.updatedAt });
        }
        for (const value of structured.lessonKeyValues) {
          lessonKeyCandidates.push({ value, updatedAt: unit.updatedAt });
        }
        if (structured.protocolOutcomes.pass > 0 || structured.protocolOutcomes.fail > 0) {
          passCount += structured.protocolOutcomes.pass;
          failCount += structured.protocolOutcomes.fail;
          continue;
        }
        if (structured.outcome === "pass") passCount += 1;
        if (structured.outcome === "fail") failCount += 1;
      }

      const rankedPatterns = rankStringValues(patternCandidates);
      const rankedRootCauses = rankStringValues(rootCauseCandidates);
      const rankedRecommendations = rankStringValues(recommendationCandidates);
      const lessonKeys = rankStringValues(lessonKeyCandidates);
      const normalizedPattern = rankedPatterns[0] ?? pattern ?? null;
      const rootCause = rankedRootCauses[0] ?? null;
      const recommendation = rankedRecommendations[0] ?? null;
      const outcomes = {
        pass: Math.max(0, passCount),
        fail: Math.max(0, failCount),
      };

      const sourceSessionIds = [
        ...new Set(sorted.flatMap((unit) => readLessonStructuredFields(unit).sourceSessionIds)),
      ].toSorted();
      const topic = normalizedPattern ? `global pattern: ${normalizedPattern}` : latest.topic;
      const globalCrystal = buildGlobalCrystalProtocol({
        pattern: normalizedPattern,
        patterns: rankedPatterns,
        rootCause,
        rootCauses: rankedRootCauses,
        recommendation,
        recommendations: rankedRecommendations,
        lessonKeys,
        outcomes,
        sourceSessionIds,
        unitCount: sorted.length,
        updatedAt: latest.updatedAt,
      });
      desiredTopicKeys.add(normalizeText(topic));
      this.store.upsertCrystal({
        sessionId: GLOBAL_MEMORY_SESSION_ID,
        topic,
        summary: summarizeGlobalUnits({
          pattern: normalizedPattern,
          rootCause,
          rootCauses: rankedRootCauses,
          recommendation,
          recommendations: rankedRecommendations,
          outcomes,
          units: sorted,
        }),
        unitIds: sorted.map((unit) => unit.id),
        confidence: sorted.reduce((acc, unit) => acc + unit.confidence, 0) / sorted.length,
        sourceRefs: mergeUnitSourceRefs(sorted),
        metadata: {
          scope: "global",
          globalCrystal: globalCrystal as unknown as JsonValue,
          pattern: normalizedPattern,
          patterns: rankedPatterns,
          rootCause,
          unitCount: sorted.length,
          sourceSessionCount: sourceSessionIds.length,
          sourceSessionIds,
          rootCauses: rankedRootCauses,
          recommendation,
          recommendations: rankedRecommendations,
          lessonKeys,
          outcomes,
        },
      });
      compiled += 1;
    }

    let removed = 0;
    for (const crystal of this.store.listCrystals(GLOBAL_MEMORY_SESSION_ID)) {
      const normalizedTopic = normalizeText(crystal.topic);
      if (desiredTopicKeys.has(normalizedTopic)) continue;
      if (this.store.removeCrystal(crystal.id)) {
        removed += 1;
      }
    }

    return { compiled, removed };
  }

  private getDecayState(): GlobalDecayState {
    if (this.decayStateLoaded) return this.decayState;
    if (!existsSync(this.decayStatePath)) {
      this.decayState = defaultDecayState();
      this.decayStateLoaded = true;
      return this.decayState;
    }
    try {
      const raw = JSON.parse(
        readFileSync(this.decayStatePath, "utf8"),
      ) as Partial<GlobalDecayState>;
      this.decayState = {
        schemaVersion: GLOBAL_DECAY_SCHEMA_VERSION,
        lastDecayAt:
          typeof raw.lastDecayAt === "number" && Number.isFinite(raw.lastDecayAt)
            ? raw.lastDecayAt
            : null,
      };
    } catch {
      this.decayState = defaultDecayState();
    }
    this.decayStateLoaded = true;
    return this.decayState;
  }

  private setDecayState(next: GlobalDecayState): void {
    this.decayState = {
      schemaVersion: GLOBAL_DECAY_SCHEMA_VERSION,
      lastDecayAt: next.lastDecayAt,
    };
    this.decayStateLoaded = true;
    writeFileAtomic(this.decayStatePath, `${JSON.stringify(this.decayState, null, 2)}\n`);
  }
}
