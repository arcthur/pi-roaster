import type { MemoryEngine } from "../memory/engine.js";
import type { BrewvaConfig, BrewvaEventRecord } from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import type { ExternalRecallDecision } from "./context-memory-injection.js";

export interface ContextExternalRecallDeps {
  config: BrewvaConfig;
  memory: MemoryEngine;
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

export function recordContextExternalRecallDecision(
  deps: ContextExternalRecallDeps,
  sessionId: string,
  finalInjectionText: string,
  externalRecallDecision: ExternalRecallDecision,
): void {
  if (externalRecallDecision.status === "disabled") return;

  if (externalRecallDecision.status === "skipped") {
    deps.recordEvent({
      sessionId,
      type: "context_external_recall_decision",
      payload: {
        outcome: "skipped",
        ...externalRecallDecision.payload,
      },
    });
    return;
  }

  const externalRecallOutcome = externalRecallDecision.outcome;
  if (finalInjectionText.includes("[ExternalRecall]")) {
    const writeback = deps.memory.ingestExternalRecall({
      sessionId,
      query: externalRecallOutcome.query,
      defaultConfidence: deps.config.memory.externalRecall.injectedConfidence,
      hits: externalRecallOutcome.hits.map((hit) => ({
        topic: hit.topic,
        excerpt: hit.excerpt,
        score: typeof hit.score === "number" ? hit.score : 0,
        confidence: hit.confidence,
        metadata: hit.metadata,
      })),
    });
    deps.recordEvent({
      sessionId,
      type: "context_external_recall_decision",
      payload: {
        outcome: "injected",
        query: externalRecallOutcome.query,
        hitCount: externalRecallOutcome.hits.length,
        internalTopScore: externalRecallOutcome.internalTopScore,
        threshold: externalRecallOutcome.threshold,
        writebackUnits: writeback.upserted,
      },
    });
    return;
  }

  deps.recordEvent({
    sessionId,
    type: "context_external_recall_decision",
    payload: {
      outcome: "filtered_out",
      reason: "filtered_out",
      query: externalRecallOutcome.query,
      hitCount: externalRecallOutcome.hits.length,
      internalTopScore: externalRecallOutcome.internalTopScore,
      threshold: externalRecallOutcome.threshold,
    },
  });
}
