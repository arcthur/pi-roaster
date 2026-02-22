import type { ContextBudgetManager } from "../context/budget.js";
import type { ContextInjectionCollector } from "../context/injection.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import type { BrewvaEventStore } from "../events/store.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import type { MemoryEngine } from "../memory/engine.js";
import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import type { FileChangeTracker } from "../state/file-change-tracker.js";
import type { TurnReplayEngine } from "../tape/replay-engine.js";
import type { VerificationGate } from "../verification/gate.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface SessionLifecycleServiceOptions {
  sessionState: RuntimeSessionStateStore;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  clearReservedInjectionTokensForSession: RuntimeCallback<[sessionId: string]>;
  fileChanges: FileChangeTracker;
  verification: VerificationGate;
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  costTracker: SessionCostTracker;
  memory: MemoryEngine;
  turnReplay: TurnReplayEngine;
  events: BrewvaEventStore;
  ledger: EvidenceLedger;
}

export class SessionLifecycleService {
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly clearReservedInjectionTokensForSession: (sessionId: string) => void;
  private readonly fileChanges: FileChangeTracker;
  private readonly verification: VerificationGate;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly costTracker: SessionCostTracker;
  private readonly memory: MemoryEngine;
  private readonly turnReplay: TurnReplayEngine;
  private readonly events: BrewvaEventStore;
  private readonly ledger: EvidenceLedger;

  constructor(options: SessionLifecycleServiceOptions) {
    this.sessionState = options.sessionState;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.clearReservedInjectionTokensForSession = options.clearReservedInjectionTokensForSession;
    this.fileChanges = options.fileChanges;
    this.verification = options.verification;
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.costTracker = options.costTracker;
    this.memory = options.memory;
    this.turnReplay = options.turnReplay;
    this.events = options.events;
    this.ledger = options.ledger;
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    const current = this.sessionState.turnsBySession.get(sessionId) ?? 0;
    const effectiveTurn = Math.max(current, turnIndex);
    this.sessionState.turnsBySession.set(sessionId, effectiveTurn);
    this.contextBudget.beginTurn(sessionId, effectiveTurn);
    this.contextInjection.clearPending(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.sessionState.clearSession(sessionId);

    this.fileChanges.clearSession(sessionId);
    this.verification.stateStore.clear(sessionId);
    this.parallel.clear(sessionId);
    this.parallelResults.clear(sessionId);
    this.contextBudget.clear(sessionId);
    this.costTracker.clear(sessionId);

    this.contextInjection.clearSession(sessionId);
    this.memory.clearSessionCache(sessionId);

    this.turnReplay.clear(sessionId);

    this.events.clearSessionCache(sessionId);
    this.ledger.clearSessionCache(sessionId);
  }
}
