import type { ViewportQuality } from "../policy/viewport-policy.js";
import type { SkillOutputRecord } from "../types.js";

export interface SessionViewportPolicySnapshot {
  quality: ViewportQuality;
  score: number | null;
  variant: string;
  updatedAt: number;
}

export interface SessionCompactionSummary {
  entryId?: string;
  summary: string;
}

export class RuntimeSessionStateStore {
  readonly activeSkillsBySession = new Map<string, string>();
  readonly turnsBySession = new Map<string, number>();
  readonly toolCallsBySession = new Map<string, number>();
  readonly latestCompactionSummaryBySession = new Map<string, SessionCompactionSummary>();
  readonly lastInjectedContextFingerprintBySession = new Map<string, string>();
  readonly reservedContextInjectionTokensByScope = new Map<string, number>();
  readonly lastLedgerCompactionTurnBySession = new Map<string, number>();
  readonly toolContractWarningsBySession = new Map<string, Set<string>>();
  readonly skillBudgetWarningsBySession = new Map<string, Set<string>>();
  readonly skillParallelWarningsBySession = new Map<string, Set<string>>();
  readonly skillOutputsBySession = new Map<string, Map<string, SkillOutputRecord>>();
  readonly viewportPolicyBySession = new Map<string, SessionViewportPolicySnapshot>();
  readonly tapeCheckpointWriteInProgressBySession = new Set<string>();
  readonly tapeCheckpointCounterInitializedBySession = new Set<string>();
  readonly tapeEntriesSinceCheckpointBySession = new Map<string, number>();
  readonly tapeLatestAnchorEventIdBySession = new Map<string, string>();
  readonly tapeLastCheckpointEventIdBySession = new Map<string, string>();
  readonly tapeProcessedEventIdsSinceCheckpointBySession = new Map<string, Set<string>>();

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
    this.activeSkillsBySession.delete(sessionId);
    this.turnsBySession.delete(sessionId);
    this.toolCallsBySession.delete(sessionId);
    this.lastLedgerCompactionTurnBySession.delete(sessionId);
    this.toolContractWarningsBySession.delete(sessionId);
    this.skillBudgetWarningsBySession.delete(sessionId);
    this.skillParallelWarningsBySession.delete(sessionId);
    this.skillOutputsBySession.delete(sessionId);
    this.latestCompactionSummaryBySession.delete(sessionId);
    this.viewportPolicyBySession.delete(sessionId);
    this.clearInjectionFingerprintsForSession(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }
}
