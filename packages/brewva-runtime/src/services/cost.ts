import type { SessionCostTracker } from "../cost/tracker.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import type { SessionCostSummary, SkillDocument } from "../types.js";
import type { RuntimeCallback } from "./callback.js";

export interface CostServiceOptions {
  costTracker: SessionCostTracker;
  ledger: EvidenceLedger;
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
    unknown
  >;
}

export class CostService {
  private readonly costTracker: SessionCostTracker;
  private readonly ledger: EvidenceLedger;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly recordEvent: CostServiceOptions["recordEvent"];

  constructor(options: CostServiceOptions) {
    this.costTracker = options.costTracker;
    this.ledger = options.ledger;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkill = options.getActiveSkill;
    this.recordEvent = options.recordEvent;
  }

  recordAssistantUsage(input: {
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    stopReason?: string;
  }): SessionCostSummary {
    const normalizedInputTokens = Math.max(0, Math.trunc(input.inputTokens));
    const normalizedOutputTokens = Math.max(0, Math.trunc(input.outputTokens));
    const normalizedCacheReadTokens = Math.max(0, Math.trunc(input.cacheReadTokens));
    const normalizedCacheWriteTokens = Math.max(0, Math.trunc(input.cacheWriteTokens));
    const providedTotalTokens = Math.max(0, Math.trunc(input.totalTokens));
    const derivedTotalTokens =
      normalizedInputTokens + normalizedOutputTokens + normalizedCacheWriteTokens;
    // Skill budgets track "new" (non-cacheRead) tokens so they remain meaningful even under heavy
    // cache reuse. If a provider does not report per-field breakdowns, fall back to the total only
    // when cacheRead is unavailable (otherwise totalTokens may include cacheRead).
    const effectiveTotalTokens =
      derivedTotalTokens > 0 || providedTotalTokens <= 0 || normalizedCacheReadTokens > 0
        ? derivedTotalTokens
        : providedTotalTokens;

    const turn = this.getCurrentTurn(input.sessionId);
    const skillName = this.getActiveSkill(input.sessionId)?.name;
    const usageResult = this.costTracker.recordUsage(
      input.sessionId,
      {
        model: input.model,
        inputTokens: normalizedInputTokens,
        outputTokens: normalizedOutputTokens,
        cacheReadTokens: normalizedCacheReadTokens,
        cacheWriteTokens: normalizedCacheWriteTokens,
        totalTokens: effectiveTotalTokens,
        costUsd: input.costUsd,
      },
      {
        turn,
        skill: skillName,
      },
    );
    const summary = usageResult.summary;

    this.recordEvent({
      sessionId: input.sessionId,
      type: "cost_update",
      turn,
      payload: {
        model: input.model,
        skill: skillName ?? null,
        inputTokens: normalizedInputTokens,
        outputTokens: normalizedOutputTokens,
        cacheReadTokens: normalizedCacheReadTokens,
        cacheWriteTokens: normalizedCacheWriteTokens,
        totalTokens: effectiveTotalTokens,
        costUsd: input.costUsd,
        sessionCostUsd: summary.totalCostUsd,
        sessionTokens: summary.totalTokens,
        budget: summary.budget,
        stopReason: input.stopReason ?? null,
      },
    });

    for (const alert of usageResult.newAlerts) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "budget_alert",
        turn,
        payload: {
          kind: alert.kind,
          scope: alert.scope,
          costUsd: alert.costUsd,
          thresholdUsd: alert.thresholdUsd,
          action: summary.budget.action,
        },
      });
    }

    this.ledger.append({
      sessionId: input.sessionId,
      turn,
      skill: skillName,
      tool: "brewva_cost",
      argsSummary: `model=${input.model}`,
      outputSummary: `tokens=${effectiveTotalTokens} cost=${input.costUsd.toFixed(6)} usd`,
      fullOutput: JSON.stringify({
        model: input.model,
        usage: {
          input: normalizedInputTokens,
          output: normalizedOutputTokens,
          cacheRead: normalizedCacheReadTokens,
          cacheWrite: normalizedCacheWriteTokens,
          total: effectiveTotalTokens,
        },
        allocation: {
          skill: skillName ?? "(none)",
          turn,
          tools: summary.tools,
        },
        costUsd: input.costUsd,
        sessionCostUsd: summary.totalCostUsd,
      }),
      verdict: "inconclusive",
      metadata: {
        source: "llm_usage",
        model: input.model,
        usage: {
          input: normalizedInputTokens,
          output: normalizedOutputTokens,
          cacheRead: normalizedCacheReadTokens,
          cacheWrite: normalizedCacheWriteTokens,
          total: effectiveTotalTokens,
        },
        skill: skillName ?? null,
        turn,
        costUsd: input.costUsd,
        sessionCostUsd: summary.totalCostUsd,
      },
    });

    return summary;
  }

  getCostSummary(sessionId: string): SessionCostSummary {
    return this.costTracker.getSummary(sessionId);
  }
}
