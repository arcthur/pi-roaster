import {
  ContextEvolutionManager,
  type ContextEvolutionDecision,
} from "../context/evolution-manager.js";
import { ContextStabilityMonitor } from "../context/stability-monitor.js";
import type { BrewvaEventRecord } from "../types.js";
import type { RuntimeCallback } from "./callback.js";

interface ContextStrategyServiceOptions {
  contextEvolution: ContextEvolutionManager | null;
  stabilityMonitor: ContextStabilityMonitor;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getSessionModel: RuntimeCallback<[sessionId: string], string>;
  getTaskClass: RuntimeCallback<[sessionId: string], string>;
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

export class ContextStrategyService {
  private readonly contextEvolution: ContextEvolutionManager | null;
  private readonly stabilityMonitor: ContextStabilityMonitor;
  private readonly getCurrentTurn: ContextStrategyServiceOptions["getCurrentTurn"];
  private readonly getSessionModel: ContextStrategyServiceOptions["getSessionModel"];
  private readonly getTaskClass: ContextStrategyServiceOptions["getTaskClass"];
  private readonly recordEvent: ContextStrategyServiceOptions["recordEvent"];
  private readonly lastStrategyFingerprintBySession = new Map<string, string>();

  constructor(options: ContextStrategyServiceOptions) {
    this.contextEvolution = options.contextEvolution;
    this.stabilityMonitor = options.stabilityMonitor;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getSessionModel = options.getSessionModel;
    this.getTaskClass = options.getTaskClass;
    this.recordEvent = options.recordEvent;
  }

  resolve(input: { sessionId: string }): ContextEvolutionDecision {
    const turn = this.getCurrentTurn(input.sessionId);
    const strategyDecision =
      this.contextEvolution === null
        ? {
            arm: "managed" as const,
            armSource: "default" as const,
            model: this.getSessionModel(input.sessionId),
            taskClass: this.getTaskClass(input.sessionId),
            adaptiveZonesEnabled: false,
            stabilityMonitorEnabled: false,
            transitions: [],
          }
        : this.contextEvolution.resolve({
            sessionId: input.sessionId,
            model: this.getSessionModel(input.sessionId),
            taskClass: this.getTaskClass(input.sessionId),
          });

    if (!strategyDecision.stabilityMonitorEnabled) {
      // Prevent stale stabilized state from leaking across strategy/retirement transitions.
      this.stabilityMonitor.clearSession(input.sessionId);
    }

    if (this.contextEvolution !== null) {
      for (const transition of strategyDecision.transitions) {
        this.recordEvent({
          sessionId: input.sessionId,
          turn,
          type: transition.toEnabled
            ? "context_evolution_feature_reenabled"
            : "context_evolution_feature_disabled",
          payload: {
            feature: transition.feature,
            metricKey: transition.metricKey,
            metricValue: transition.metricValue,
            sampleSize: transition.sampleSize,
            model: strategyDecision.model,
            taskClass: strategyDecision.taskClass,
          },
        });
      }
      const strategyFingerprint = [
        turn,
        strategyDecision.arm,
        strategyDecision.armSource,
        strategyDecision.adaptiveZonesEnabled ? "1" : "0",
        strategyDecision.stabilityMonitorEnabled ? "1" : "0",
        strategyDecision.model,
        strategyDecision.taskClass,
      ].join("|");
      const previousStrategyFingerprint = this.lastStrategyFingerprintBySession.get(
        input.sessionId,
      );
      if (previousStrategyFingerprint !== strategyFingerprint) {
        this.lastStrategyFingerprintBySession.set(input.sessionId, strategyFingerprint);
        this.recordEvent({
          sessionId: input.sessionId,
          turn,
          type: "context_strategy_selected",
          payload: {
            arm: strategyDecision.arm,
            source: strategyDecision.armSource,
            adaptiveZonesEnabled: strategyDecision.adaptiveZonesEnabled,
            stabilityMonitorEnabled: strategyDecision.stabilityMonitorEnabled,
            model: strategyDecision.model,
            taskClass: strategyDecision.taskClass,
          },
        });
      }
    }

    return strategyDecision;
  }

  clearSession(sessionId: string): void {
    this.lastStrategyFingerprintBySession.delete(sessionId);
  }
}
