import type { ContextArenaDegradationPolicy, ContextStrategyArm } from "../types.js";
import { ContextArena } from "./arena.js";
import type { ZoneBudgetAdaptiveConfig } from "./zone-budget-controller.js";
import type { ZoneBudgetConfigInput } from "./zone-budget.js";
import type { ContextZone } from "./zones.js";

export type ContextInjectionPriority = "critical" | "high" | "normal" | "low";
export type ContextInjectionTruncationStrategy = "drop-entry" | "summarize" | "tail";

export interface RegisterContextInjectionInput {
  source: string;
  id: string;
  content: string;
  priority?: ContextInjectionPriority;
  estimatedTokens?: number;
  oncePerSession?: boolean;
}

export interface ContextInjectionEntry {
  source: string;
  id: string;
  content: string;
  priority: ContextInjectionPriority;
  estimatedTokens: number;
  timestamp: number;
  oncePerSession: boolean;
  truncated: boolean;
}

export interface ContextInjectionConsumeResult {
  text: string;
  entries: ContextInjectionEntry[];
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextInjectionPlanTelemetry {
  strategyArm: ContextStrategyArm;
  zoneDemandTokens: Record<ContextZone, number>;
  zoneAllocatedTokens: Record<ContextZone, number>;
  zoneAcceptedTokens: Record<ContextZone, number>;
  adaptiveZonesDisabled: boolean;
  stabilityForced: boolean;
  floorUnmet: boolean;
  appliedFloorRelaxation: ContextZone[];
  degradationApplied: ContextArenaDegradationPolicy | null;
  zoneAdaptation: {
    movedTokens: number;
    maxByZone: Record<ContextZone, number>;
    shifts: Array<{ from: ContextZone; to: ContextZone; tokens: number }>;
    turn: number;
  } | null;
}

export interface ContextInjectionPlanResult extends ContextInjectionConsumeResult {
  consumedKeys: string[];
  planReason?: "floor_unmet";
  planTelemetry: ContextInjectionPlanTelemetry;
}

export interface ContextInjectionRegisterResult {
  accepted: boolean;
  sloEnforced?: {
    policy: ContextArenaDegradationPolicy;
    entriesBefore: number;
    entriesAfter: number;
    dropped: boolean;
  };
}

export class ContextInjectionCollector {
  private readonly arena: ContextArena;

  constructor(
    options: {
      sourceTokenLimits?: Record<string, number>;
      truncationStrategy?: ContextInjectionTruncationStrategy;
      zoneLayout?: boolean;
      zoneBudgets?: ZoneBudgetConfigInput;
      adaptiveZones?: ZoneBudgetAdaptiveConfig;
      maxEntriesPerSession?: number;
      degradationPolicy?: ContextArenaDegradationPolicy;
      floorUnmetPolicy?: {
        enabled?: boolean;
        relaxOrder?: ContextZone[];
        finalFallback?: "critical_only";
      };
    } = {},
  ) {
    this.arena = new ContextArena({
      sourceTokenLimits: options.sourceTokenLimits,
      truncationStrategy: options.truncationStrategy,
      zoneLayout: options.zoneLayout ?? true,
      zoneBudgets: options.zoneBudgets,
      adaptiveZones: options.adaptiveZones,
      maxEntriesPerSession: options.maxEntriesPerSession,
      degradationPolicy: options.degradationPolicy,
      floorUnmetPolicy: options.floorUnmetPolicy,
    });
  }

  register(
    sessionId: string,
    input: RegisterContextInjectionInput,
  ): ContextInjectionRegisterResult {
    return this.arena.append(sessionId, input);
  }

  plan(
    sessionId: string,
    totalTokenBudget: number,
    options?: {
      forceCriticalOnly?: boolean;
      disableAdaptiveZones?: boolean;
    },
  ): ContextInjectionPlanResult {
    return this.arena.plan(sessionId, totalTokenBudget, options);
  }

  commit(sessionId: string, consumedKeys: string[]): void {
    this.arena.markPresented(sessionId, consumedKeys);
  }

  consume(sessionId: string, totalTokenBudget: number): ContextInjectionConsumeResult {
    const plan = this.plan(sessionId, totalTokenBudget);
    this.commit(sessionId, plan.consumedKeys);
    return {
      text: plan.text,
      entries: plan.entries,
      estimatedTokens: plan.estimatedTokens,
      truncated: plan.truncated,
    };
  }

  clearPending(sessionId: string): void {
    this.arena.clearPending(sessionId);
  }

  onCompaction(sessionId: string): void {
    this.arena.resetEpoch(sessionId);
  }

  clearSession(sessionId: string): void {
    this.arena.clearSession(sessionId);
  }
}
