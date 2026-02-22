import {
  TRUTH_EVENT_TYPE,
  buildTruthFactResolvedEvent,
  buildTruthFactUpsertedEvent,
} from "../truth/ledger.js";
import type { TruthFact, TruthFactSeverity, TruthFactStatus, TruthState } from "../types.js";
import { normalizeJsonRecord } from "../utils/json.js";
import type { RuntimeCallback } from "./callback.js";

export interface TruthServiceOptions {
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
}

export class TruthService {
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly recordEvent: TruthServiceOptions["recordEvent"];

  constructor(options: TruthServiceOptions) {
    this.getTruthState = options.getTruthState;
    this.recordEvent = options.recordEvent;
  }

  upsertTruthFact(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: TruthFactStatus;
    },
  ): { ok: boolean; fact?: TruthFact; error?: string } {
    const id = input.id?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const kind = input.kind?.trim();
    if (!kind) return { ok: false, error: "missing_kind" };

    const summary = input.summary?.trim();
    if (!summary) return { ok: false, error: "missing_summary" };

    const now = Date.now();
    const state = this.getTruthState(sessionId);
    const existing = state.facts.find((fact) => fact.id === id);
    const status: TruthFactStatus = input.status ?? "active";
    const evidenceIds = [
      ...new Set([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])]),
    ];

    const fact: TruthFact = {
      id,
      kind,
      status,
      severity: input.severity,
      summary,
      details: normalizeJsonRecord(input.details),
      evidenceIds,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      resolvedAt: status === "resolved" ? (existing?.resolvedAt ?? now) : undefined,
    };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactUpsertedEvent(fact) as unknown as Record<string, unknown>,
    });
    return { ok: true, fact };
  }

  resolveTruthFact(sessionId: string, truthFactId: string): { ok: boolean; error?: string } {
    const id = truthFactId?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactResolvedEvent({
        factId: id,
        resolvedAt: Date.now(),
      }) as unknown as Record<string, unknown>,
    });
    return { ok: true };
  }
}
