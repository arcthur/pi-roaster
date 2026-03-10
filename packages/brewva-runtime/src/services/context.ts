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
import type { ToolFailureEntry } from "../context/tool-failures.js";
import type { ToolOutputDistillationEntry } from "../context/tool-output-distilled.js";
import type { GovernancePort } from "../governance/port.js";
import { ProjectionEngine } from "../projection/engine.js";
import { sanitizeByTrust, wrapByTrust } from "../security/sanitize.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextCompactionReason,
  ContextCompactionGateStatus,
  ContextPressureLevel,
  ContextPressureStatus,
  ProposalRecord,
  SkillChainIntent,
  SkillDispatchDecision,
  SkillDocument,
  TaskState,
  TruthState,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import { type ContextCompactionDeps, markContextCompacted } from "./context-compaction.js";
import { ContextPressureService } from "./context-pressure.js";
import { ContextProjectionInjectionService } from "./context-projection-injection.js";
import {
  type ContextSupplementalBudgetDeps,
  commitSupplementalContextInjection,
  planSupplementalContextInjection,
} from "./context-supplemental-budget.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface ContextServiceOptions {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  alwaysAllowedTools: string[];
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  projectionEngine: ProjectionEngine;
  recordInfrastructureRow: ContextCompactionDeps["recordInfrastructureRow"];
  sessionState: RuntimeSessionStateStore;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  getLatestSkillSelectionProposal: RuntimeCallback<
    [sessionId: string],
    ProposalRecord<"skill_selection"> | undefined
  >;
  getAcceptedContextPackets: RuntimeCallback<
    [sessionId: string, injectionScopeId?: string],
    ProposalRecord<"context_packet">[]
  >;
  getPendingSkillDispatch: RuntimeCallback<[sessionId: string], SkillDispatchDecision | undefined>;
  buildSkillCandidateBlock: RuntimeCallback<[selected: SkillDispatchDecision["selected"]], string>;
  buildSkillDispatchGateBlock: RuntimeCallback<[decision: SkillDispatchDecision], string>;
  getSkillCascadeIntent: RuntimeCallback<[sessionId: string], SkillChainIntent | undefined>;
  buildSkillCascadeGateBlock: RuntimeCallback<[intent: SkillChainIntent], string>;
  buildTaskStateBlock: RuntimeCallback<[state: TaskState], string>;
  maybeAlignTaskStatus: RuntimeCallback<
    [
      input: {
        sessionId: string;
        promptText: string;
        truthState: TruthState;
        usage?: ContextBudgetUsage;
      },
    ]
  >;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
  sanitizeInput: RuntimeCallback<[text: string], string>;
  getFoldedToolFailures: RuntimeCallback<[sessionId: string], ToolFailureEntry[]>;
  getRecentToolOutputDistillations: RuntimeCallback<
    [sessionId: string],
    ToolOutputDistillationEntry[]
  >;
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
  governancePort?: GovernancePort;
}

export class ContextService {
  private readonly cwd: string;
  private readonly config: BrewvaConfig;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly projectionEngine: ProjectionEngine;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly getLatestSkillSelectionProposal: (
    sessionId: string,
  ) => ProposalRecord<"skill_selection"> | undefined;
  private readonly getAcceptedContextPackets: (
    sessionId: string,
    injectionScopeId?: string,
  ) => ProposalRecord<"context_packet">[];
  private readonly getPendingSkillDispatch: (
    sessionId: string,
  ) => SkillDispatchDecision | undefined;
  private readonly buildSkillCandidateBlock: (
    selected: SkillDispatchDecision["selected"],
  ) => string;
  private readonly buildSkillDispatchGateBlock: (decision: SkillDispatchDecision) => string;
  private readonly getSkillCascadeIntent: (sessionId: string) => SkillChainIntent | undefined;
  private readonly buildSkillCascadeGateBlock: (intent: SkillChainIntent) => string;
  private readonly buildTaskStateBlock: (state: TaskState) => string;
  private readonly maybeAlignTaskStatus: ContextServiceOptions["maybeAlignTaskStatus"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly sanitizeInput: (text: string) => string;
  private readonly getFoldedToolFailures: (sessionId: string) => ToolFailureEntry[];
  private readonly getRecentToolOutputDistillations: (
    sessionId: string,
  ) => ToolOutputDistillationEntry[];
  private readonly recordEvent: ContextServiceOptions["recordEvent"];
  private readonly contextPressure: ContextPressureService;
  private readonly contextProjectionInjection: ContextProjectionInjectionService;
  private readonly contextCompactionDeps: ContextCompactionDeps;
  private readonly contextSupplementalBudgetDeps: ContextSupplementalBudgetDeps;
  private readonly contextInjectionOrchestratorDeps: ContextInjectionOrchestratorDeps;

  constructor(options: ContextServiceOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.projectionEngine = options.projectionEngine;
    this.sessionState = options.sessionState;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.getLatestSkillSelectionProposal = options.getLatestSkillSelectionProposal;
    this.getAcceptedContextPackets = options.getAcceptedContextPackets;
    this.getPendingSkillDispatch = options.getPendingSkillDispatch;
    this.buildSkillCandidateBlock = options.buildSkillCandidateBlock;
    this.buildSkillDispatchGateBlock = options.buildSkillDispatchGateBlock;
    this.getSkillCascadeIntent = options.getSkillCascadeIntent;
    this.buildSkillCascadeGateBlock = options.buildSkillCascadeGateBlock;
    this.buildTaskStateBlock = options.buildTaskStateBlock;
    this.maybeAlignTaskStatus = options.maybeAlignTaskStatus;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkill = options.getActiveSkill;
    this.sanitizeInput = options.sanitizeInput;
    this.getFoldedToolFailures = options.getFoldedToolFailures;
    this.getRecentToolOutputDistillations = options.getRecentToolOutputDistillations;
    this.recordEvent = options.recordEvent;

    this.contextPressure = new ContextPressureService({
      config: this.config,
      contextBudget: this.contextBudget,
      alwaysAllowedTools: options.alwaysAllowedTools,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });

    this.contextProjectionInjection = new ContextProjectionInjectionService({
      workspaceRoot: options.workspaceRoot,
      agentId: options.agentId,
      config: this.config,
      projectionEngine: this.projectionEngine,
      sanitizeInput: (text) => this.sanitizeInput(text),
      registerContextInjection: (sessionId, input) =>
        this.registerContextInjection(sessionId, input),
      recordEvent: (input) => this.recordEvent(input),
    });

    this.contextCompactionDeps = {
      sessionState: this.sessionState,
      recordInfrastructureRow: options.recordInfrastructureRow,
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
      cwd: this.cwd,
      maxInjectionTokens: this.config.infrastructure.contextBudget.maxInjectionTokens,
      isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
      getToolFailureInjectionConfig: () => this.config.infrastructure.toolFailureInjection,
      getToolOutputDistillationInjectionConfig: () =>
        this.config.infrastructure.toolOutputDistillationInjection,
      sanitizeInput: (text) => this.sanitizeInput(text),
      getTruthState: (id) => this.getTruthState(id),
      maybeAlignTaskStatus: (orchestrationInput) => this.maybeAlignTaskStatus(orchestrationInput),
      getRecentToolFailures: (id) => this.getRecentToolFailures(id),
      getRecentToolOutputDistillations: (id) => this.getRecentToolOutputDistillationsBlock(id),
      getTaskState: (id) => this.getTaskState(id),
      buildTaskStateBlock: (state) => this.buildTaskStateBlock(state),
      getLatestSkillSelectionProposal: (id) => this.getLatestSkillSelectionProposal(id),
      getAcceptedContextPackets: (id, injectionScopeId) =>
        this.getAcceptedContextPackets(id, injectionScopeId),
      getPendingSkillDispatch: (id) => this.getPendingSkillDispatch(id),
      buildSkillCandidateBlock: (selected) => this.buildSkillCandidateBlock(selected),
      buildSkillDispatchGateBlock: (decision) => this.buildSkillDispatchGateBlock(decision),
      getActiveSkillName: (id) => this.getActiveSkill(id)?.name ?? null,
      getSkillCascadeIntent: (id) => this.getSkillCascadeIntent(id),
      buildSkillCascadeGateBlock: (intent) => this.buildSkillCascadeGateBlock(intent),
      registerLateContextInjection: (id, promptText, usage) =>
        this.contextProjectionInjection.registerProjectionContextInjection(id, promptText, usage),
      registerContextInjection: (id, registerInput) =>
        this.registerContextInjection(id, registerInput),
      recordEvent: (eventInput) => this.recordEvent(eventInput),
      planContextInjection: (id, tokenBudget) => this.contextInjection.plan(id, tokenBudget),
      commitContextInjection: (id, consumedKeys) => this.contextInjection.commit(id, consumedKeys),
      planBudgetInjection: (id, inputText, budgetUsage) =>
        this.contextBudget.planInjection(id, inputText, budgetUsage),
      buildInjectionScopeKey: (id, scopeId) => this.buildInjectionScopeKey(id, scopeId),
      setReservedTokens: (scopeKey, tokens) =>
        this.sessionState.reservedContextInjectionTokensByScope.set(scopeKey, tokens),
      getLastInjectedFingerprint: (scopeKey) =>
        this.sessionState.lastInjectedContextFingerprintBySession.get(scopeKey),
      setLastInjectedFingerprint: (scopeKey, fingerprint) =>
        this.sessionState.lastInjectedContextFingerprintBySession.set(scopeKey, fingerprint),
      getCurrentTurn: (id) => this.getCurrentTurn(id),
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
    this.contextProjectionInjection.registerIdentityContextInjection(sessionId);
    const finalized = this.finalizeContextInjection(sessionId, prompt, usage, injectionScopeId);
    return finalized;
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

  private getRecentToolFailures(sessionId: string): ToolFailureEntry[] {
    const folded = this.getFoldedToolFailures(sessionId);
    return folded.map((entry) => ({
      toolName: entry.toolName,
      args: entry.args,
      outputText: this.sanitizeInput(entry.outputText),
      turn: Number.isFinite(entry.turn) ? Math.max(0, Math.floor(entry.turn)) : 0,
    }));
  }

  private getRecentToolOutputDistillationsBlock(sessionId: string): ToolOutputDistillationEntry[] {
    const entries = this.getRecentToolOutputDistillations(sessionId);
    return entries
      .map((entry) => ({
        toolName: entry.toolName,
        strategy: entry.strategy,
        summaryText: this.sanitizeInput(entry.summaryText),
        rawTokens: entry.rawTokens,
        summaryTokens: entry.summaryTokens,
        compressionRatio: entry.compressionRatio,
        artifactRef: entry.artifactRef ? this.sanitizeInput(entry.artifactRef) : null,
        isError: entry.isError,
        turn: entry.turn,
        timestamp: entry.timestamp,
      }))
      .filter((entry) => entry.summaryText.trim().length > 0);
  }

  private registerContextInjection(
    sessionId: string,
    input: {
      source: string;
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
