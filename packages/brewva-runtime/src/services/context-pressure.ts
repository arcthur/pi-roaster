import { ContextBudgetManager } from "../context/budget.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextPressureLevel,
  ContextPressureStatus,
} from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { RuntimeCallback } from "./callback.js";

interface ContextPressureServiceOptions {
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
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

export class ContextPressureService {
  private readonly config: BrewvaConfig;
  private readonly contextBudget: ContextBudgetManager;
  private readonly getCurrentTurn: ContextPressureServiceOptions["getCurrentTurn"];
  private readonly recordEvent: ContextPressureServiceOptions["recordEvent"];

  constructor(options: ContextPressureServiceOptions) {
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
  }

  observeContextUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
    this.contextBudget.observeUsage(sessionId, usage);
    if (!usage) return;
    this.recordEvent({
      sessionId,
      type: "context_usage",
      payload: {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      },
    });
  }

  getContextUsage(sessionId: string): ContextBudgetUsage | undefined {
    const snapshot = this.contextBudget.snapshotSession(sessionId);
    const usage = snapshot?.lastContextUsage;
    if (!usage) return undefined;
    return {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    };
  }

  getContextUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
    if (!usage) return null;
    const normalizedPercent = this.normalizeRatio(usage.percent);
    if (normalizedPercent !== null) return normalizedPercent;
    if (typeof usage.tokens !== "number") return null;
    if (!Number.isFinite(usage.tokens) || usage.tokens < 0) return null;
    if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
      return null;
    }
    return Math.max(0, Math.min(1, usage.tokens / usage.contextWindow));
  }

  getContextHardLimitRatio(): number {
    const ratio = this.normalizeRatio(this.config.infrastructure.contextBudget.hardLimitPercent);
    if (ratio === null) return 1;
    return Math.max(0, Math.min(1, ratio));
  }

  getContextCompactionThresholdRatio(): number {
    const thresholdRatio = this.normalizeRatio(
      this.config.infrastructure.contextBudget.compactionThresholdPercent,
    );
    return thresholdRatio ?? this.getContextHardLimitRatio();
  }

  getContextPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus {
    const effectiveUsage = usage ?? this.getContextUsage(sessionId);
    const usageRatio = this.getContextUsageRatio(effectiveUsage);
    if (usageRatio === null) {
      return {
        level: "unknown",
        usageRatio: null,
        hardLimitRatio: this.getContextHardLimitRatio(),
        compactionThresholdRatio: this.getContextCompactionThresholdRatio(),
      };
    }

    const hardLimitRatio = this.getContextHardLimitRatio();
    const compactionThresholdRatio = this.getContextCompactionThresholdRatio();

    let level: ContextPressureLevel = "none";
    if (usageRatio >= hardLimitRatio) {
      level = "critical";
    } else if (usageRatio >= compactionThresholdRatio) {
      level = "high";
    } else {
      const mediumThreshold = Math.max(0.5, compactionThresholdRatio * 0.75);
      if (usageRatio >= mediumThreshold) {
        level = "medium";
      } else {
        const lowThreshold = Math.max(0.25, compactionThresholdRatio * 0.5);
        if (usageRatio >= lowThreshold) {
          level = "low";
        }
      }
    }

    return {
      level,
      usageRatio,
      hardLimitRatio,
      compactionThresholdRatio,
    };
  }

  getContextPressureLevel(sessionId: string, usage?: ContextBudgetUsage): ContextPressureLevel {
    return this.getContextPressureStatus(sessionId, usage).level;
  }

  getRecentCompactionWindowTurns(): number {
    return Math.max(1, this.config.infrastructure.contextBudget.compaction.minTurnsBetween);
  }

  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus {
    const pressure = this.getContextPressureStatus(sessionId, usage);
    const windowTurns = this.getRecentCompactionWindowTurns();

    const snapshot = this.contextBudget.snapshotSession(sessionId);
    const lastCompactionTurn =
      snapshot && Number.isFinite(snapshot.lastCompactionTurn)
        ? Math.floor(snapshot.lastCompactionTurn)
        : null;
    const turnsSinceCompaction =
      lastCompactionTurn === null
        ? null
        : Math.max(0, this.getCurrentTurn(sessionId) - lastCompactionTurn);
    const recentCompaction =
      turnsSinceCompaction !== null && Number.isFinite(turnsSinceCompaction)
        ? turnsSinceCompaction < windowTurns
        : false;
    const pendingReason = this.getPendingCompactionReason(sessionId);
    const required =
      this.config.infrastructure.contextBudget.enabled &&
      ((pressure.level === "critical" && !recentCompaction) || pendingReason === "floor_unmet");
    const reason: ContextCompactionReason | null = required
      ? (pendingReason ?? (pressure.level === "critical" ? "hard_limit" : "usage_threshold"))
      : null;

    return {
      required,
      reason,
      pressure,
      recentCompaction,
      windowTurns,
      lastCompactionTurn,
      turnsSinceCompaction,
    };
  }

  checkContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName === "session_compact") {
      return { allowed: true };
    }

    const gate = this.getContextCompactionGateStatus(sessionId, usage);
    if (!gate.required) {
      return { allowed: true };
    }

    const reason =
      gate.reason === "floor_unmet"
        ? "Context floor requirements are unmet. Call tool 'session_compact' first, then continue with other tools."
        : "Context usage is critical. Call tool 'session_compact' first, then continue with other tools.";
    this.recordEvent({
      sessionId,
      type: "context_compaction_gate_blocked_tool",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        blockedTool: toolName,
        reason:
          gate.reason === "floor_unmet"
            ? "context_floor_unmet_without_compaction"
            : "critical_context_pressure_without_compaction",
        usagePercent: gate.pressure.usageRatio,
        hardLimitPercent: gate.pressure.hardLimitRatio,
      },
    });
    return { allowed: false, reason };
  }

  shouldRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean {
    const decision = this.contextBudget.shouldRequestCompaction(sessionId, usage);
    if (!decision.shouldCompact) return false;
    this.requestCompaction(sessionId, decision.reason ?? "usage_threshold", decision.usage);
    return true;
  }

  requestCompaction(
    sessionId: string,
    reason: ContextCompactionReason,
    usage?: ContextBudgetUsage,
  ): void {
    const pendingReason = this.contextBudget.getPendingCompactionReason(sessionId);
    if (pendingReason === reason) {
      return;
    }
    this.contextBudget.requestCompaction(sessionId, reason);
    this.recordEvent({
      sessionId,
      type: "context_compaction_requested",
      payload: {
        reason,
        usagePercent: usage?.percent ?? null,
        tokens: usage?.tokens ?? null,
      },
    });
  }

  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null {
    return this.contextBudget.getPendingCompactionReason(sessionId);
  }

  getCompactionInstructions(): string {
    return this.contextBudget.getCompactionInstructions();
  }

  markCompacted(sessionId: string): void {
    this.contextBudget.markCompacted(sessionId);
  }

  private normalizeRatio(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value >= 0 && value <= 1) return value;
    if (value > 1 && value <= 100) return value / 100;
    if (value < 0) return 0;
    return 1;
  }
}
