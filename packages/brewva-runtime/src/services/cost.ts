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
    const turn = this.getCurrentTurn(input.sessionId);
    const skillName = this.getActiveSkill(input.sessionId)?.name;
    const usageResult = this.costTracker.recordUsage(
      input.sessionId,
      {
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens,
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
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens,
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
          scopeId: alert.scopeId ?? null,
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
      outputSummary: `tokens=${input.totalTokens} cost=${input.costUsd.toFixed(6)} usd`,
      fullOutput: JSON.stringify({
        model: input.model,
        usage: {
          input: input.inputTokens,
          output: input.outputTokens,
          cacheRead: input.cacheReadTokens,
          cacheWrite: input.cacheWriteTokens,
          total: input.totalTokens,
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
          input: input.inputTokens,
          output: input.outputTokens,
          cacheRead: input.cacheReadTokens,
          cacheWrite: input.cacheWriteTokens,
          total: input.totalTokens,
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
