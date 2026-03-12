import { ContextBudgetManager } from "../context/budget.js";
import {
  buildContextInjection as buildContextInjectionOrchestrated,
  type ContextInjectionOrchestratorDeps,
} from "../context/injection-orchestrator.js";
import type { ContextInjectionEntry } from "../context/injection.js";
import {
  ContextInjectionCollector,
  type ContextInjectionRegisterResult,
} from "../context/injection.js";
import {
  type ContextSourceProvider,
  type ContextSourceProviderDescriptor,
  ContextSourceProviderRegistry,
} from "../context/provider.js";
import type { GovernancePort } from "../governance/port.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { sanitizeByTrust, wrapByTrust } from "../security/sanitize.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextPressureLevel,
  ContextPressureStatus,
  SkillDocument,
  TruthState,
} from "../types.js";
import { type ContextCompactionDeps, markContextCompacted } from "./context-compaction.js";
import { ContextPressureService } from "./context-pressure.js";
import {
  commitSupplementalContextInjection,
  planSupplementalContextInjection,
  type ContextSupplementalBudgetDeps,
} from "./context-supplemental-budget.js";
import type { LedgerService } from "./ledger.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import type { TaskService } from "./task.js";

export interface ContextServiceOptions {
  config: RuntimeKernelContext["config"];
  contextBudget: RuntimeKernelContext["contextBudget"];
  contextInjection: RuntimeKernelContext["contextInjection"];
  sessionState: RuntimeKernelContext["sessionState"];
  getTruthState: RuntimeKernelContext["getTruthState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  sanitizeInput: RuntimeKernelContext["sanitizeInput"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  alwaysAllowedTools: string[];
  contextSourceProviders: ContextSourceProviderRegistry;
  ledgerService: Pick<LedgerService, "recordInfrastructureRow">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  taskService: Pick<TaskService, "maybeAlignTaskStatus">;
  governancePort?: GovernancePort;
}

export class ContextService {
  private readonly config: BrewvaConfig;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly maybeAlignTaskStatus: (input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }) => void;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly sanitizeInput: (text: string) => string;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => BrewvaEventRecord | undefined;
  private readonly contextPressure: ContextPressureService;
  private readonly contextSourceProviders: ContextSourceProviderRegistry;
  private readonly contextCompactionDeps: ContextCompactionDeps;
  private readonly contextSupplementalBudgetDeps: ContextSupplementalBudgetDeps;
  private readonly contextInjectionOrchestratorDeps: ContextInjectionOrchestratorDeps;

  constructor(options: ContextServiceOptions) {
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.sessionState = options.sessionState;
    this.getTruthState = (sessionId) => options.getTruthState(sessionId);
    this.maybeAlignTaskStatus = (input) => options.taskService.maybeAlignTaskStatus(input);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.sanitizeInput = (text) => options.sanitizeInput(text);
    this.recordEvent = (input) => options.recordEvent(input);

    this.contextPressure = new ContextPressureService({
      config: this.config,
      contextBudget: this.contextBudget,
      alwaysAllowedTools: options.alwaysAllowedTools,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
    this.contextSourceProviders = options.contextSourceProviders;

    this.contextCompactionDeps = {
      sessionState: this.sessionState,
      recordInfrastructureRow: (input) => options.ledgerService.recordInfrastructureRow(input),
      governancePort: options.governancePort,
      markPressureCompacted: (sessionId) => this.contextPressure.markCompacted(sessionId),
      markInjectionCompacted: (sessionId) => this.contextInjection.onCompaction(sessionId),
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getActiveSkill: (sessionId) => this.getActiveSkill(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    };

    this.contextSupplementalBudgetDeps = {
      config: this.config,
      contextBudget: this.contextBudget,
      sessionState: this.sessionState,
    };

    this.contextInjectionOrchestratorDeps = {
      providers: this.contextSourceProviders,
      maxInjectionTokens: this.config.infrastructure.contextBudget.maxInjectionTokens,
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
      sanitizeInput: (text) => this.sanitizeInput(text),
      getTruthState: (id) => this.getTruthState(id),
      maybeAlignTaskStatus: (orchestrationInput) => this.maybeAlignTaskStatus(orchestrationInput),
      registerContextInjection: (id, registerInput) =>
        this.registerContextInjection(id, registerInput),
      recordEvent: (eventInput) => this.recordEvent(eventInput),
      planContextInjection: (id, tokenBudget) => this.contextInjection.plan(id, tokenBudget),
      commitContextInjection: (id, consumedKeys) => this.contextInjection.commit(id, consumedKeys),
      planBudgetInjection: (id, inputText, budgetUsage) =>
        this.contextBudget.planInjection(id, inputText, budgetUsage),
      buildInjectionScopeKey: (id, scopeId) => this.buildInjectionScopeKey(id, scopeId),
      setReservedTokens: (scopeKey, tokens) =>
        this.sessionState.setReservedInjectionTokens(scopeKey, tokens),
      getLastInjectedFingerprint: (scopeKey) =>
        this.sessionState.getLastInjectedFingerprint(scopeKey),
      setLastInjectedFingerprint: (scopeKey, fingerprint) =>
        this.sessionState.setLastInjectedFingerprint(scopeKey, fingerprint),
    };
  }

  observeContextUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
    this.contextPressure.observeContextUsage(sessionId, usage);
  }

  getContextUsage(sessionId: string): ContextBudgetUsage | undefined {
    return this.contextPressure.getContextUsage(sessionId);
  }

  getContextUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
    return this.contextPressure.getContextUsageRatio(usage);
  }

  getContextHardLimitRatio(): number {
    return this.contextPressure.getContextHardLimitRatio();
  }

  getContextCompactionThresholdRatio(): number {
    return this.contextPressure.getContextCompactionThresholdRatio();
  }

  getContextPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus {
    return this.contextPressure.getContextPressureStatus(sessionId, usage);
  }

  getContextPressureLevel(sessionId: string, usage?: ContextBudgetUsage): ContextPressureLevel {
    return this.contextPressure.getContextPressureLevel(sessionId, usage);
  }

  getRecentCompactionWindowTurns(): number {
    return this.contextPressure.getRecentCompactionWindowTurns();
  }

  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus {
    return this.contextPressure.getContextCompactionGateStatus(sessionId, usage);
  }

  checkContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    return this.contextPressure.checkContextCompactionGate(sessionId, toolName, usage);
  }

  explainContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    return this.contextPressure.explainContextCompactionGate(sessionId, toolName, usage);
  }

  registerContextSourceProvider(provider: ContextSourceProvider): void {
    this.contextSourceProviders.register(provider);
  }

  unregisterContextSourceProvider(source: string): boolean {
    return this.contextSourceProviders.unregister(source);
  }

  listContextSourceProviders(): readonly ContextSourceProviderDescriptor[] {
    return this.contextSourceProviders.list();
  }

  async buildContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): Promise<{
    text: string;
    entries: ContextInjectionEntry[];
    accepted: boolean;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
  }> {
    return this.finalizeContextInjection(sessionId, prompt, usage, injectionScopeId);
  }

  appendSupplementalContextInjection(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): {
    accepted: boolean;
    text: string;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
    droppedReason?: "hard_limit" | "budget_exhausted";
  } {
    const plan = planSupplementalContextInjection(
      this.contextSupplementalBudgetDeps,
      sessionId,
      inputText,
      usage,
      injectionScopeId,
    );
    if (plan.accepted && plan.finalTokens > 0) {
      commitSupplementalContextInjection(
        this.contextSupplementalBudgetDeps,
        sessionId,
        plan.finalTokens,
        injectionScopeId,
      );
    }
    return plan;
  }

  checkAndRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean {
    return this.contextPressure.checkAndRequestCompaction(sessionId, usage);
  }

  requestCompaction(
    sessionId: string,
    reason: ContextCompactionReason,
    usage?: ContextBudgetUsage,
  ): void {
    this.contextPressure.requestCompaction(sessionId, reason, usage);
  }

  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null {
    return this.contextPressure.getPendingCompactionReason(sessionId);
  }

  getCompactionInstructions(): string {
    return this.contextPressure.getCompactionInstructions();
  }

  markContextCompacted(
    sessionId: string,
    input: {
      fromTokens?: number | null;
      toTokens?: number | null;
      summary?: string;
      entryId?: string;
    },
  ): void {
    markContextCompacted(this.contextCompactionDeps, sessionId, input);
  }

  isContextBudgetEnabled(): boolean {
    return this.config.infrastructure.contextBudget.enabled;
  }

  buildInjectionScopeKey(sessionId: string, scopeId?: string): string {
    return this.sessionState.buildInjectionScopeKey(sessionId, scopeId);
  }

  clearInjectionFingerprintsForSession(sessionId: string): void {
    this.sessionState.clearInjectionFingerprintsForSession(sessionId);
  }

  clearReservedInjectionTokensForSession(sessionId: string): void {
    this.sessionState.clearReservedInjectionTokensForSession(sessionId);
  }

  private finalizeContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): {
    text: string;
    entries: ContextInjectionEntry[];
    accepted: boolean;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
  } {
    return buildContextInjectionOrchestrated(this.contextInjectionOrchestratorDeps, {
      sessionId,
      prompt,
      usage,
      injectionScopeId,
    });
  }

  private registerContextInjection(
    sessionId: string,
    input: {
      source: string;
      category: ContextInjectionEntry["category"];
      id: string;
      content: string;
      estimatedTokens?: number;
      oncePerSession?: boolean;
    },
  ): ContextInjectionRegisterResult {
    const sanitizedContent = this.config.security.sanitizeContext
      ? sanitizeByTrust(input.content, input.source)
      : wrapByTrust(input.content, input.source);
    const result = this.contextInjection.register(sessionId, {
      ...input,
      content: sanitizedContent,
    });
    if (result.sloEnforced) {
      this.recordEvent({
        sessionId,
        type: "context_arena_slo_enforced",
        payload: {
          entriesBefore: result.sloEnforced.entriesBefore,
          entriesAfter: result.sloEnforced.entriesAfter,
          dropped: result.sloEnforced.dropped,
          source: input.source,
        },
      });
    }
    return result;
  }
}
