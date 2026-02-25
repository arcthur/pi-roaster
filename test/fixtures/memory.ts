import type { MemoryCrystal, MemoryUnit } from "@brewva/brewva-runtime";

export interface MemoryUnitFixtureInput {
  id: string;
  topic: string;
  statement: string;
  sessionId?: string;
  type?: MemoryUnit["type"];
  status?: MemoryUnit["status"];
  confidence?: number;
  metadata?: MemoryUnit["metadata"];
  fingerprint?: string;
  sourceRefs?: MemoryUnit["sourceRefs"];
  updatedAt?: number;
}

export interface MemoryUnitFactoryOptions extends Omit<
  MemoryUnitFixtureInput,
  "id" | "topic" | "statement"
> {
  sourceRefsFactory?: (
    input: MemoryUnitFixtureInput,
    timestamp: number,
  ) => MemoryUnit["sourceRefs"];
}

export function createMemoryUnit(input: MemoryUnitFixtureInput): MemoryUnit {
  const timestamp = input.updatedAt ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId ?? "memory-test-session",
    type: input.type ?? "fact",
    status: input.status ?? "active",
    topic: input.topic,
    statement: input.statement,
    confidence: input.confidence ?? 0.8,
    fingerprint: input.fingerprint ?? `fp-${input.id}`,
    sourceRefs: input.sourceRefs ?? [],
    metadata: input.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  };
}

export function createMemoryCrystal(input: {
  id: string;
  topic: string;
  summary: string;
  sessionId?: string;
  confidence?: number;
  updatedAt?: number;
  unitIds?: string[];
  metadata?: MemoryCrystal["metadata"];
}): MemoryCrystal {
  const timestamp = input.updatedAt ?? Date.now();
  return {
    id: input.id,
    sessionId: input.sessionId ?? "memory-test-session",
    topic: input.topic,
    summary: input.summary,
    unitIds: input.unitIds ?? ["u1"],
    confidence: input.confidence ?? 0.9,
    sourceRefs: [],
    metadata: input.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createMemoryUnitFactory(
  options: MemoryUnitFactoryOptions = {},
): (input: MemoryUnitFixtureInput) => MemoryUnit {
  const { sourceRefsFactory, ...defaults } = options;
  return (input: MemoryUnitFixtureInput): MemoryUnit => {
    const timestamp = input.updatedAt ?? defaults.updatedAt ?? Date.now();
    const sourceRefs =
      input.sourceRefs ??
      (sourceRefsFactory ? sourceRefsFactory(input, timestamp) : defaults.sourceRefs);
    return createMemoryUnit({
      ...defaults,
      ...input,
      updatedAt: timestamp,
      sourceRefs,
    });
  };
}
