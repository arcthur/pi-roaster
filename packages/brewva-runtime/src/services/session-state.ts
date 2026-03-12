import type {
  ResourceLeaseRecord,
  SessionHydrationState,
  SkillChainIntent,
  SkillDispatchDecision,
  SkillOutputRecord,
} from "../types.js";

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

export class RuntimeSessionStateCell {
  activeSkill?: string;
  turn = 0;
  toolCalls = 0;
  lastInjectedContextFingerprintByScope = new Map<string, string>();
  reservedContextInjectionTokensByScope = new Map<string, number>();
  lastLedgerCompactionTurn?: number;
  toolContractWarnings = new Set<string>();
  skillBudgetWarnings = new Set<string>();
  skillParallelWarnings = new Set<string>();
  resourceLeases = new Map<string, ResourceLeaseRecord>();
  skillOutputs = new Map<string, SkillOutputRecord>();
  pendingDispatch?: SkillDispatchDecision;
  skillChainIntent?: SkillChainIntent;
  tapeCheckpointWriteInProgress = false;
  tapeCheckpointCounterInitialized = false;
  tapeEntriesSinceCheckpoint = 0;
  tapeLatestAnchorEventId?: string;
  tapeLastCheckpointEventId?: string;
  tapeProcessedEventIdsSinceCheckpoint = new Set<string>();
  scanConvergence?: ScanConvergenceRuntimeState;
  scanConvergenceHydrated = false;
  hydration: SessionHydrationState = {
    status: "cold",
    issues: [],
  };
}

export class RuntimeSessionStateStore {
  private readonly cells = new Map<string, RuntimeSessionStateCell>();

  private static readSessionIdFromScopeKey(scopeKey: string): string {
    const separatorIndex = scopeKey.indexOf("::");
    if (separatorIndex < 0) {
      throw new Error(`Invalid injection scope key '${scopeKey}'.`);
    }
    const sessionId = scopeKey.slice(0, separatorIndex).trim();
    if (!sessionId) {
      throw new Error(`Invalid injection scope key '${scopeKey}'.`);
    }
    return sessionId;
  }

  getCell(sessionId: string): RuntimeSessionStateCell {
    const existing = this.cells.get(sessionId);
    if (existing) return existing;

    const created = new RuntimeSessionStateCell();
    this.cells.set(sessionId, created);
    return created;
  }

  getExistingCell(sessionId: string): RuntimeSessionStateCell | undefined {
    return this.cells.get(sessionId);
  }

  getCurrentTurn(sessionId: string): number {
    return this.cells.get(sessionId)?.turn ?? 0;
  }

  buildInjectionScopeKey(sessionId: string, scopeId?: string): string {
    const normalizedScope = scopeId?.trim();
    if (!normalizedScope) return `${sessionId}::root`;
    return `${sessionId}::${normalizedScope}`;
  }

  getReservedInjectionTokens(scopeKey: string): number | undefined {
    return this.getExistingCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    )?.reservedContextInjectionTokensByScope.get(scopeKey);
  }

  setReservedInjectionTokens(scopeKey: string, tokens: number): void {
    this.getCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    ).reservedContextInjectionTokensByScope.set(scopeKey, tokens);
  }

  getLastInjectedFingerprint(scopeKey: string): string | undefined {
    return this.getExistingCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    )?.lastInjectedContextFingerprintByScope.get(scopeKey);
  }

  setLastInjectedFingerprint(scopeKey: string, fingerprint: string): void {
    this.getCell(
      RuntimeSessionStateStore.readSessionIdFromScopeKey(scopeKey),
    ).lastInjectedContextFingerprintByScope.set(scopeKey, fingerprint);
  }

  clearInjectionFingerprintsForSession(sessionId: string): void {
    this.cells.get(sessionId)?.lastInjectedContextFingerprintByScope.clear();
  }

  clearReservedInjectionTokensForSession(sessionId: string): void {
    this.cells.get(sessionId)?.reservedContextInjectionTokensByScope.clear();
  }

  clearSession(sessionId: string): void {
    this.cells.delete(sessionId);
  }
}
