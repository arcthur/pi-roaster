import type { SkillChainIntent, SkillDispatchDecision, SkillOutputRecord } from "../types.js";

export type ScanConvergenceReason =
  | "scan_only_turns"
  | "investigation_only_turns"
  | "scan_failures";

export type ScanConvergenceResetReason = "strategy_shift" | "input_reset";

export type ScanConvergenceToolStrategy =
  | "raw_scan"
  | "low_signal"
  | "evidence_reuse"
  | "progress"
  | "neutral";

export interface ScanConvergenceRuntimeState {
  currentTurnRawScanToolCalls: number;
  currentTurnLowSignalToolCalls: number;
  currentTurnConvergenceToolCalls: number;
  consecutiveScanOnlyTurns: number;
  consecutiveInvestigationOnlyTurns: number;
  consecutiveScanFailures: number;
  armedReason: ScanConvergenceReason | null;
  toolStrategyByCallId: Map<string, ScanConvergenceToolStrategy>;
}

export class RuntimeSessionStateStore {
  readonly activeSkillsBySession = new Map<string, string>();
  readonly turnsBySession = new Map<string, number>();
  readonly toolCallsBySession = new Map<string, number>();
  readonly lastInjectedContextFingerprintBySession = new Map<string, string>();
  readonly reservedContextInjectionTokensByScope = new Map<string, number>();
  readonly lastLedgerCompactionTurnBySession = new Map<string, number>();
  readonly toolContractWarningsBySession = new Map<string, Set<string>>();
  readonly skillBudgetWarningsBySession = new Map<string, Set<string>>();
  readonly skillParallelWarningsBySession = new Map<string, Set<string>>();
  readonly skillDispatchGateWarningsBySession = new Map<string, Set<string>>();
  readonly skillOutputsBySession = new Map<string, Map<string, SkillOutputRecord>>();
  readonly pendingDispatchBySession = new Map<string, SkillDispatchDecision>();
  readonly skillChainIntentsBySession = new Map<string, SkillChainIntent>();
  readonly tapeCheckpointWriteInProgressBySession = new Set<string>();
  readonly tapeCheckpointCounterInitializedBySession = new Set<string>();
  readonly tapeEntriesSinceCheckpointBySession = new Map<string, number>();
  readonly tapeLatestAnchorEventIdBySession = new Map<string, string>();
  readonly tapeLastCheckpointEventIdBySession = new Map<string, string>();
  readonly tapeProcessedEventIdsSinceCheckpointBySession = new Map<string, Set<string>>();
  readonly scanConvergenceBySession = new Map<string, ScanConvergenceRuntimeState>();
  readonly scanConvergenceHydratedBySession = new Set<string>();

  getCurrentTurn(sessionId: string): number {
    return this.turnsBySession.get(sessionId) ?? 0;
  }

  buildInjectionScopeKey(sessionId: string, scopeId?: string): string {
    const normalizedScope = scopeId?.trim();
    if (!normalizedScope) return `${sessionId}::root`;
    return `${sessionId}::${normalizedScope}`;
  }

  clearInjectionFingerprintsForSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of this.lastInjectedContextFingerprintBySession.keys()) {
      if (key.startsWith(prefix)) {
        this.lastInjectedContextFingerprintBySession.delete(key);
      }
    }
  }

  clearReservedInjectionTokensForSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of this.reservedContextInjectionTokensByScope.keys()) {
      if (key.startsWith(prefix)) {
        this.reservedContextInjectionTokensByScope.delete(key);
      }
    }
  }

  clearSession(sessionId: string): void {
    this.tapeCheckpointWriteInProgressBySession.delete(sessionId);
    this.tapeCheckpointCounterInitializedBySession.delete(sessionId);
    this.tapeEntriesSinceCheckpointBySession.delete(sessionId);
    this.tapeLatestAnchorEventIdBySession.delete(sessionId);
    this.tapeLastCheckpointEventIdBySession.delete(sessionId);
    this.tapeProcessedEventIdsSinceCheckpointBySession.delete(sessionId);
    this.scanConvergenceBySession.delete(sessionId);
    this.scanConvergenceHydratedBySession.delete(sessionId);
    this.activeSkillsBySession.delete(sessionId);
    this.turnsBySession.delete(sessionId);
    this.toolCallsBySession.delete(sessionId);
    this.lastLedgerCompactionTurnBySession.delete(sessionId);
    this.toolContractWarningsBySession.delete(sessionId);
    this.skillBudgetWarningsBySession.delete(sessionId);
    this.skillParallelWarningsBySession.delete(sessionId);
    this.skillDispatchGateWarningsBySession.delete(sessionId);
    this.skillOutputsBySession.delete(sessionId);
    this.pendingDispatchBySession.delete(sessionId);
    this.skillChainIntentsBySession.delete(sessionId);
    this.clearInjectionFingerprintsForSession(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }
}
