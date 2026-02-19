import type { BrewvaEventRecord, TruthFact, TruthFactStatus, TruthLedgerEventPayload, TruthState } from "../types.js";
import { isRecord, normalizeNonEmptyString, normalizeStringArray } from "../utils/coerce.js";

export const TRUTH_EVENT_TYPE = "truth_event";
export const TRUTH_LEDGER_SCHEMA = "brewva.truth.ledger.v1" as const;

type FactUpsertedEvent = Extract<TruthLedgerEventPayload, { kind: "fact_upserted" }>;
type FactResolvedEvent = Extract<TruthLedgerEventPayload, { kind: "fact_resolved" }>;

function normalizeStatus(value: unknown): TruthFactStatus | undefined {
  if (value === "active" || value === "resolved") return value;
  return undefined;
}

function normalizeSeverity(value: unknown): TruthFact["severity"] | undefined {
  if (value === "info" || value === "warn" || value === "error") return value;
  return undefined;
}

export function createEmptyTruthState(): TruthState {
  return {
    facts: [],
    updatedAt: null,
  };
}

export function isTruthLedgerPayload(value: unknown): value is TruthLedgerEventPayload {
  if (!isRecord(value)) return false;
  if (value.schema !== TRUTH_LEDGER_SCHEMA) return false;
  if (typeof value.kind !== "string") return false;
  return true;
}

function mergeEvidenceIds(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming || incoming.length === 0) return existing;
  const out = new Set(existing);
  for (const id of incoming) out.add(id);
  return [...out.values()];
}

export function reduceTruthState(state: TruthState, payload: TruthLedgerEventPayload, timestamp: number): TruthState {
  const updatedAt = Math.max(state.updatedAt ?? 0, timestamp);

  if (payload.kind === "fact_upserted") {
    const incoming = payload.fact;
    const existing = state.facts.find((fact) => fact.id === incoming.id);

    const merged: TruthFact = existing
      ? {
          ...existing,
          kind: incoming.kind,
          status: incoming.status,
          severity: incoming.severity,
          summary: incoming.summary,
          details: incoming.details,
          evidenceIds: mergeEvidenceIds(existing.evidenceIds, incoming.evidenceIds),
          lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
        }
      : incoming;

    const facts = existing
      ? state.facts.map((fact) => (fact.id === merged.id ? merged : fact))
      : [...state.facts, merged];
    return {
      ...state,
      facts,
      updatedAt,
    };
  }

  if (payload.kind === "fact_resolved") {
    const id = payload.factId;
    const facts = state.facts.map((fact) => {
      if (fact.id !== id) return fact;
      if (fact.status === "resolved") return fact;
      return {
        ...fact,
        status: "resolved" as TruthFactStatus,
        resolvedAt: payload.resolvedAt ?? timestamp,
        lastSeenAt: Math.max(fact.lastSeenAt, timestamp),
      };
    });
    return {
      ...state,
      facts,
      updatedAt,
    };
  }

  return {
    ...state,
    updatedAt,
  };
}

export function foldTruthLedgerEvents(events: BrewvaEventRecord[]): TruthState {
  let state = createEmptyTruthState();
  for (const event of events) {
    const payload = coerceTruthLedgerPayload(event.payload);
    if (!payload) continue;
    state = reduceTruthState(state, payload, event.timestamp);
  }
  return state;
}

export function buildTruthFactUpsertedEvent(fact: TruthFact): FactUpsertedEvent {
  return {
    schema: TRUTH_LEDGER_SCHEMA,
    kind: "fact_upserted",
    fact,
  };
}

export function buildTruthFactResolvedEvent(input: { factId: string; resolvedAt?: number }): FactResolvedEvent {
  return {
    schema: TRUTH_LEDGER_SCHEMA,
    kind: "fact_resolved",
    factId: input.factId,
    resolvedAt: input.resolvedAt,
  };
}

function coerceTruthFact(value: unknown): TruthFact | null {
  if (!isRecord(value)) return null;

  const id = normalizeNonEmptyString(value.id);
  const kind = normalizeNonEmptyString(value.kind);
  const status = normalizeStatus(value.status);
  const severity = normalizeSeverity(value.severity);
  const summary = normalizeNonEmptyString(value.summary);

  const firstSeenAt = typeof value.firstSeenAt === "number" ? value.firstSeenAt : null;
  const lastSeenAt = typeof value.lastSeenAt === "number" ? value.lastSeenAt : null;
  const resolvedAt = typeof value.resolvedAt === "number" ? value.resolvedAt : undefined;

  if (!id || !kind || !status || !severity || !summary) return null;
  if (firstSeenAt === null || lastSeenAt === null) return null;

  const evidenceIds = normalizeStringArray(value.evidenceIds) ?? [];
  const details = isRecord(value.details) ? (value.details as TruthFact["details"]) : undefined;

  return {
    id,
    kind,
    status,
    severity,
    summary,
    details,
    evidenceIds,
    firstSeenAt,
    lastSeenAt,
    resolvedAt,
  };
}

export function coerceTruthLedgerPayload(value: unknown): TruthLedgerEventPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TRUTH_LEDGER_SCHEMA) return null;

  const kind = value.kind;
  if (kind === "fact_upserted") {
    const fact = coerceTruthFact(value.fact as unknown);
    if (!fact) return null;
    return {
      schema: TRUTH_LEDGER_SCHEMA,
      kind,
      fact,
    };
  }

  if (kind === "fact_resolved") {
    const factId = normalizeNonEmptyString(value.factId);
    if (!factId) return null;
    const resolvedAt = typeof value.resolvedAt === "number" ? value.resolvedAt : undefined;
    return {
      schema: TRUTH_LEDGER_SCHEMA,
      kind,
      factId,
      resolvedAt,
    };
  }

  return null;
}
