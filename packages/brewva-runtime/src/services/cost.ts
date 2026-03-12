import type { SessionCostTracker } from "../cost/tracker.js";
import type { GovernancePort } from "../governance/port.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { SessionCostSummary, SkillDocument } from "../types.js";
import type { LedgerService } from "./ledger.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

export interface CostServiceOptions {
  costTracker: RuntimeKernelContext["costTracker"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  ledgerService: Pick<LedgerService, "recordInfrastructureRow">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  governancePort?: GovernancePort;
}

export class CostService {
  private readonly costTracker: SessionCostTracker;
  private readonly recordInfrastructureRow: (input: {
    sessionId: string;
    tool: string;
    argsSummary: string;
    outputSummary: string;
    fullOutput?: string;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
    turn?: number;
    skill?: string | null;
  }) => string;
  private readonly governancePort?: GovernancePort;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;

  constructor(options: CostServiceOptions) {
    this.costTracker = options.costTracker;
    this.recordInfrastructureRow = (input) => options.ledgerService.recordInfrastructureRow(input);
    this.governancePort = options.governancePort;
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
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

    const ledgerId = this.recordInfrastructureRow({
      sessionId: input.sessionId,
      turn,
      skill: skillName ?? null,
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
        stopReason: input.stopReason ?? null,
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
        stopReason: input.stopReason ?? null,
      },
    });

    this.recordEvent({
      sessionId: input.sessionId,
      type: "cost_update",
      turn,
      payload: {
        model: input.model,
        skill: skillName ?? null,
        ledgerId,
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

    this.maybeDetectCostAnomaly(input.sessionId, turn, summary);
    return summary;
  }

  getCostSummary(sessionId: string): SessionCostSummary {
    return this.costTracker.getSummary(sessionId);
  }

  private maybeDetectCostAnomaly(
    sessionId: string,
    turn: number,
    summary: SessionCostSummary,
  ): void {
    const governancePort = this.governancePort;
    if (!governancePort?.detectCostAnomaly) return;
    const detectCostAnomaly = governancePort.detectCostAnomaly.bind(governancePort);

    void Promise.resolve()
      .then(() => detectCostAnomaly({ sessionId, summary }))
      .then((result) => {
        if (!result.anomaly) return;
        this.recordEvent({
          sessionId,
          type: "governance_cost_anomaly_detected",
          turn,
          payload: {
            reason: result.reason ?? "unknown",
            totalCostUsd: summary.totalCostUsd,
            totalTokens: summary.totalTokens,
          },
        });
      })
      .catch((error) => {
        this.recordEvent({
          sessionId,
          type: "governance_cost_anomaly_error",
          turn,
          payload: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }
}
