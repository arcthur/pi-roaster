import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import type { BrewvaEventRecord, SkillDocument } from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import type { RuntimeSessionStateStore } from "./session-state.js";

export interface ContextCompactionInput {
  fromTokens?: number | null;
  toTokens?: number | null;
  summary?: string;
  entryId?: string;
}

export interface ContextCompactionDeps {
  sessionState: RuntimeSessionStateStore;
  ledger: EvidenceLedger;
  markPressureCompacted: RuntimeCallback<[sessionId: string]>;
  markInjectionCompacted: RuntimeCallback<[sessionId: string]>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
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
    BrewvaEventRecord | undefined
  >;
}

export function markContextCompacted(
  deps: ContextCompactionDeps,
  sessionId: string,
  input: ContextCompactionInput,
): void {
  deps.markPressureCompacted(sessionId);
  deps.markInjectionCompacted(sessionId);
  deps.sessionState.clearInjectionFingerprintsForSession(sessionId);
  deps.sessionState.clearReservedInjectionTokensForSession(sessionId);

  const turn = deps.getCurrentTurn(sessionId);
  const summary = input.summary?.trim();
  const entryId = input.entryId?.trim();

  deps.recordEvent({
    sessionId,
    type: "context_compacted",
    turn,
    payload: {
      fromTokens: input.fromTokens ?? null,
      toTokens: input.toTokens ?? null,
      entryId: entryId ?? null,
      summaryChars: summary?.length ?? null,
    },
  });

  deps.ledger.append({
    sessionId,
    turn,
    skill: deps.getActiveSkill(sessionId)?.name,
    tool: "brewva_context_compaction",
    argsSummary: "context_compaction",
    outputSummary: `from=${input.fromTokens ?? "unknown"} to=${input.toTokens ?? "unknown"}`,
    fullOutput: JSON.stringify({
      fromTokens: input.fromTokens ?? null,
      toTokens: input.toTokens ?? null,
    }),
    verdict: "inconclusive",
    metadata: {
      source: "context_budget",
      fromTokens: input.fromTokens ?? null,
      toTokens: input.toTokens ?? null,
      entryId: entryId ?? null,
      summaryChars: summary?.length ?? null,
    },
  });
}
