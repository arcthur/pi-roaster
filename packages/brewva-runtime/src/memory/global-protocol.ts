import {
  GLOBAL_CRYSTAL_PROTOCOL_SCHEMA,
  GLOBAL_LESSON_PROTOCOL_SCHEMA,
  type MemoryCrystal,
  type MemoryGlobalCrystalProtocol,
  type MemoryKnowledgeFacets,
  type MemoryGlobalLessonProtocol,
  type MemoryUnit,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readOptionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export function readGlobalCrystalProtocol(
  metadata: MemoryCrystal["metadata"] | undefined,
): MemoryGlobalCrystalProtocol | null {
  const candidate = metadata?.["globalCrystal"];
  if (!isRecord(candidate)) return null;
  if (candidate.schema !== GLOBAL_CRYSTAL_PROTOCOL_SCHEMA) return null;
  if (candidate.version !== 1) return null;

  const sourceSessionCount = Number(candidate.sourceSessionCount);
  const unitCount = Number(candidate.unitCount);
  const updatedAt = Number(candidate.updatedAt);
  const passCountRaw = Number(isRecord(candidate.outcomes) ? candidate.outcomes.pass : NaN);
  const failCountRaw = Number(isRecord(candidate.outcomes) ? candidate.outcomes.fail : NaN);
  const passCount = Number.isFinite(passCountRaw) ? passCountRaw : 0;
  const failCount = Number.isFinite(failCountRaw) ? failCountRaw : 0;
  if (
    !Number.isFinite(sourceSessionCount) ||
    !Number.isFinite(unitCount) ||
    !Number.isFinite(updatedAt)
  ) {
    return null;
  }

  const pattern = readOptionalString(candidate.pattern);
  const rootCause = readOptionalString(candidate.rootCause);
  const recommendation = readOptionalString(candidate.recommendation);
  const patterns = uniqueStrings([pattern, ...readStringArray(candidate.patterns)]);
  const rootCauses = uniqueStrings([rootCause, ...readStringArray(candidate.rootCauses)]);
  const recommendations = uniqueStrings([
    recommendation,
    ...readStringArray(candidate.recommendations),
  ]);

  return {
    schema: GLOBAL_CRYSTAL_PROTOCOL_SCHEMA,
    version: 1,
    pattern: pattern ?? patterns[0] ?? null,
    patterns,
    rootCause: rootCause ?? rootCauses[0] ?? null,
    rootCauses,
    recommendation: recommendation ?? recommendations[0] ?? null,
    recommendations,
    lessonKeys: readStringArray(candidate.lessonKeys),
    outcomes: {
      pass: Math.max(0, Math.trunc(passCount)),
      fail: Math.max(0, Math.trunc(failCount)),
    },
    sourceSessionIds: readStringArray(candidate.sourceSessionIds),
    sourceSessionCount: Math.max(0, Math.trunc(sourceSessionCount)),
    unitCount: Math.max(0, Math.trunc(unitCount)),
    updatedAt,
  };
}

export function readGlobalLessonProtocol(
  metadata: MemoryUnit["metadata"] | undefined,
): MemoryGlobalLessonProtocol | null {
  const candidate = metadata?.["globalLesson"];
  if (!isRecord(candidate)) return null;
  if (candidate.schema !== GLOBAL_LESSON_PROTOCOL_SCHEMA) return null;
  if (candidate.version !== 1) return null;

  const sourceSessionCount = Number(candidate.sourceSessionCount);
  const updatedAt = Number(candidate.updatedAt);
  const passCountRaw = Number(isRecord(candidate.outcomes) ? candidate.outcomes.pass : NaN);
  const failCountRaw = Number(isRecord(candidate.outcomes) ? candidate.outcomes.fail : NaN);
  const passCount = Number.isFinite(passCountRaw) ? passCountRaw : 0;
  const failCount = Number.isFinite(failCountRaw) ? failCountRaw : 0;
  if (!Number.isFinite(sourceSessionCount) || !Number.isFinite(updatedAt)) {
    return null;
  }

  const pattern = readOptionalString(candidate.pattern);
  const rootCause = readOptionalString(candidate.rootCause);
  const recommendation = readOptionalString(candidate.recommendation);
  const patterns = uniqueStrings([pattern, ...readStringArray(candidate.patterns)]);
  const rootCauses = uniqueStrings([rootCause, ...readStringArray(candidate.rootCauses)]);
  const recommendations = uniqueStrings([
    recommendation,
    ...readStringArray(candidate.recommendations),
  ]);

  return {
    schema: GLOBAL_LESSON_PROTOCOL_SCHEMA,
    version: 1,
    lessonKey: readOptionalString(candidate.lessonKey),
    pattern: pattern ?? patterns[0] ?? null,
    patterns,
    rootCause: rootCause ?? rootCauses[0] ?? null,
    rootCauses,
    recommendation: recommendation ?? recommendations[0] ?? null,
    recommendations,
    outcomes: {
      pass: Math.max(0, Math.trunc(passCount)),
      fail: Math.max(0, Math.trunc(failCount)),
    },
    sourceSessionIds: readStringArray(candidate.sourceSessionIds),
    sourceSessionCount: Math.max(0, Math.trunc(sourceSessionCount)),
    updatedAt,
  };
}

export function readLearningKnowledgeFacets(
  metadata: MemoryUnit["metadata"] | undefined,
): MemoryKnowledgeFacets | null {
  const protocol = readGlobalLessonProtocol(metadata);
  if (protocol) return buildKnowledgeFacetsFromLessonProtocol(protocol);
  if (!isRecord(metadata)) return null;

  const lessonKey = readOptionalString(metadata.lessonKey);
  const pattern = readOptionalString(metadata.pattern);
  const rootCause = readOptionalString(metadata.rootCause);
  const recommendation =
    readOptionalString(metadata.recommendation) ?? readOptionalString(metadata.adjustedStrategy);

  const patterns = uniqueStrings([pattern, ...readStringArray(metadata.patterns)]);
  const rootCauses = uniqueStrings([rootCause, ...readStringArray(metadata.rootCauses)]);
  const recommendations = uniqueStrings([
    recommendation,
    ...readStringArray(metadata.recommendations),
  ]);

  const passCountRaw = Number(isRecord(metadata.outcomes) ? metadata.outcomes.pass : NaN);
  const failCountRaw = Number(isRecord(metadata.outcomes) ? metadata.outcomes.fail : NaN);
  let passCount = Number.isFinite(passCountRaw) ? Math.max(0, Math.trunc(passCountRaw)) : 0;
  let failCount = Number.isFinite(failCountRaw) ? Math.max(0, Math.trunc(failCountRaw)) : 0;
  if (passCount === 0 && failCount === 0) {
    const outcome =
      readOptionalString(metadata.lessonOutcome) ??
      readOptionalString(metadata.verificationOutcome) ??
      readOptionalString(metadata.outcome);
    if (outcome === "pass") passCount = 1;
    if (outcome === "fail") failCount = 1;
  }

  const sourceSessionIds = readStringArray(metadata.sourceSessionIds);
  const sourceSessionCountRaw = Number(metadata.sourceSessionCount);
  const sourceSessionCount = Number.isFinite(sourceSessionCountRaw)
    ? Math.max(0, Math.trunc(sourceSessionCountRaw))
    : sourceSessionIds.length > 0
      ? sourceSessionIds.length
      : 1;

  const hasSignal =
    Boolean(lessonKey) ||
    patterns.length > 0 ||
    rootCauses.length > 0 ||
    recommendations.length > 0 ||
    passCount > 0 ||
    failCount > 0 ||
    sourceSessionIds.length > 0;
  if (!hasSignal) return null;

  return {
    pattern: pattern ?? patterns[0] ?? null,
    patterns,
    rootCause: rootCause ?? rootCauses[0] ?? null,
    rootCauses,
    recommendation: recommendation ?? recommendations[0] ?? null,
    recommendations,
    lessonKey,
    lessonKeys: lessonKey ? [lessonKey] : [],
    outcomes: {
      pass: passCount,
      fail: failCount,
    },
    sourceSessionIds,
    sourceSessionCount,
    unitCount: null,
  };
}

export function buildKnowledgeFacetsFromLessonProtocol(
  protocol: MemoryGlobalLessonProtocol,
): MemoryKnowledgeFacets {
  return {
    pattern: protocol.pattern,
    patterns: protocol.patterns,
    rootCause: protocol.rootCause,
    rootCauses: protocol.rootCauses,
    recommendation: protocol.recommendation,
    recommendations: protocol.recommendations,
    lessonKey: protocol.lessonKey,
    lessonKeys: protocol.lessonKey ? [protocol.lessonKey] : [],
    outcomes: {
      pass: protocol.outcomes.pass,
      fail: protocol.outcomes.fail,
    },
    sourceSessionIds: protocol.sourceSessionIds,
    sourceSessionCount: protocol.sourceSessionCount,
    unitCount: null,
  };
}

export function buildKnowledgeFacetsFromCrystalProtocol(
  protocol: MemoryGlobalCrystalProtocol,
): MemoryKnowledgeFacets {
  return {
    pattern: protocol.pattern,
    patterns: protocol.patterns,
    rootCause: protocol.rootCause,
    rootCauses: protocol.rootCauses,
    recommendation: protocol.recommendation,
    recommendations: protocol.recommendations,
    lessonKey: protocol.lessonKeys[0] ?? null,
    lessonKeys: protocol.lessonKeys,
    outcomes: {
      pass: protocol.outcomes.pass,
      fail: protocol.outcomes.fail,
    },
    sourceSessionIds: protocol.sourceSessionIds,
    sourceSessionCount: protocol.sourceSessionCount,
    unitCount: protocol.unitCount,
  };
}
