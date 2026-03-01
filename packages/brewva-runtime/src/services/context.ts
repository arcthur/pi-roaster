import { ContextBudgetManager } from "../context/budget.js";
import { ContextEvolutionManager } from "../context/evolution-manager.js";
import { buildContextInjection as buildContextInjectionOrchestrated } from "../context/injection-orchestrator.js";
import {
  ContextInjectionCollector,
  type ContextInjectionPriority,
  type ContextInjectionRegisterResult,
} from "../context/injection.js";
import { ContextStabilityMonitor } from "../context/stability-monitor.js";
import type { ToolFailureEntry } from "../context/tool-failures.js";
import type { ExternalRecallPort } from "../external-recall/types.js";
import { EvidenceLedger } from "../ledger/evidence-ledger.js";
import { MemoryEngine } from "../memory/engine.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextCompactionReason,
  ContextCompactionGateStatus,
  ContextPressureLevel,
  ContextPressureStatus,
  SessionCostSummary,
  SkillDispatchDecision,
  SkillDocument,
  TaskState,
  TruthState,
} from "../types.js";
import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import type { RuntimeCallback } from "./callback.js";
import {
  ContextMemoryInjectionService,
  type ExternalRecallInjectionOutcome,
} from "./context-memory-injection.js";
import { ContextPressureService } from "./context-pressure.js";
import { ContextStrategyService } from "./context-strategy.js";
import { RuntimeSessionStateStore } from "./session-state.js";

const SIMPLE_PROFILE_IGNORED_OPTION_KEYS = [
  "infrastructure.contextBudget.arena.zones",
  "infrastructure.contextBudget.adaptiveZones",
  "infrastructure.contextBudget.stabilityMonitor",
  "infrastructure.contextBudget.floorUnmetPolicy",
  "infrastructure.toolFailureInjection.sourceTokenLimitsDerived",
] as const;

export interface ContextServiceOptions {
  cwd: string;
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  stabilityMonitor: ContextStabilityMonitor;
  memory: MemoryEngine;
  externalRecallPort?: ExternalRecallPort;
  ledger: EvidenceLedger;
  sessionState: RuntimeSessionStateStore;
  listSessionIds: RuntimeCallback<[], string[]>;
  listEvents: RuntimeCallback<[sessionId: string], BrewvaEventRecord[]>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  getCostSummary: RuntimeCallback<[sessionId: string], SessionCostSummary>;
  prepareSkillDispatch: RuntimeCallback<
    [
      input: {
        sessionId: string;
        promptText: string;
        turn: number;
      },
    ],
    SkillDispatchDecision
  >;
  buildSkillCandidateBlock: RuntimeCallback<[selected: SkillDispatchDecision["selected"]], string>;
  buildSkillDispatchGateBlock: RuntimeCallback<[decision: SkillDispatchDecision], string>;
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

export class ContextService {
  private readonly cwd: string;
  private readonly config: BrewvaConfig;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly stabilityMonitor: ContextStabilityMonitor;
  private readonly memory: MemoryEngine;
  private readonly ledger: EvidenceLedger;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly getCostSummary: (sessionId: string) => SessionCostSummary;
  private readonly prepareSkillDispatch: (input: {
    sessionId: string;
    promptText: string;
    turn: number;
  }) => SkillDispatchDecision;
  private readonly buildSkillCandidateBlock: (
    selected: SkillDispatchDecision["selected"],
  ) => string;
  private readonly buildSkillDispatchGateBlock: (decision: SkillDispatchDecision) => string;
  private readonly buildTaskStateBlock: (state: TaskState) => string;
  private readonly maybeAlignTaskStatus: ContextServiceOptions["maybeAlignTaskStatus"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly sanitizeInput: (text: string) => string;
  private readonly getFoldedToolFailures: (sessionId: string) => ToolFailureEntry[];
  private readonly recordEvent: ContextServiceOptions["recordEvent"];
  private readonly contextProfile: BrewvaConfig["infrastructure"]["contextBudget"]["profile"];
  private readonly contextPressure: ContextPressureService;
  private readonly contextMemoryInjection: ContextMemoryInjectionService;
  private readonly contextStrategy: ContextStrategyService;

  constructor(options: ContextServiceOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.stabilityMonitor = options.stabilityMonitor;
    this.memory = options.memory;
    this.ledger = options.ledger;
    this.sessionState = options.sessionState;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.getCostSummary = options.getCostSummary;
    this.prepareSkillDispatch = options.prepareSkillDispatch;
    this.buildSkillCandidateBlock = options.buildSkillCandidateBlock;
    this.buildSkillDispatchGateBlock = options.buildSkillDispatchGateBlock;
    this.buildTaskStateBlock = options.buildTaskStateBlock;
    this.maybeAlignTaskStatus = options.maybeAlignTaskStatus;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkill = options.getActiveSkill;
    this.sanitizeInput = options.sanitizeInput;
    this.getFoldedToolFailures = options.getFoldedToolFailures;
    this.recordEvent = options.recordEvent;

    this.contextProfile = this.config.infrastructure.contextBudget.profile;

    const contextEvolution =
      this.contextProfile === "managed"
        ? new ContextEvolutionManager({
            config: this.config.infrastructure.contextBudget,
            listSessionIds: () => options.listSessionIds(),
            listEvents: (sessionId) => options.listEvents(sessionId),
          })
        : null;

    this.contextPressure = new ContextPressureService({
      config: this.config,
      contextBudget: this.contextBudget,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });

    this.contextMemoryInjection = new ContextMemoryInjectionService({
      workspaceRoot: options.workspaceRoot,
      agentId: options.agentId,
      config: this.config,
      memory: this.memory,
      externalRecallPort: options.externalRecallPort,
      sanitizeInput: (text) => this.sanitizeInput(text),
      getTaskState: (sessionId) => this.getTaskState(sessionId),
      getActiveSkill: (sessionId) => this.getActiveSkill(sessionId),
      getContextPressureLevel: (sessionId, usage) =>
        this.contextPressure.getContextPressureLevel(sessionId, usage),
      registerContextInjection: (sessionId, input) =>
        this.registerContextInjection(sessionId, input),
      recordEvent: (input) => this.recordEvent(input),
    });

    this.contextStrategy = new ContextStrategyService({
      contextEvolution,
      stabilityMonitor: this.stabilityMonitor,
      getCurrentTurn: (sessionId) => this.getCurrentTurn(sessionId),
      getSessionModel: (sessionId) => this.resolveSessionModel(sessionId),
      getTaskClass: (sessionId) => this.resolveTaskClass(sessionId),
      recordEvent: (input) => this.recordEvent(input),
    });
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

  async buildContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): Promise<{
    text: string;
    accepted: boolean;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
  }> {
    this.ensureContextProfileEvents(sessionId);
    this.contextMemoryInjection.registerIdentityContextInjection(sessionId);
    const externalRecallOutcome = await this.contextMemoryInjection.registerMemoryContextInjection(
      sessionId,
      prompt,
      usage,
    );
    const finalized = this.finalizeContextInjection(sessionId, prompt, usage, injectionScopeId);

    this.maybeWriteBackExternalRecall(sessionId, finalized.text, externalRecallOutcome);
    return finalized;
  }

  planSupplementalContextInjection(
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
    const decision = this.contextBudget.planInjection(sessionId, inputText, usage);
    if (!decision.accepted) {
      return {
        accepted: false,
        text: "",
        originalTokens: decision.originalTokens,
        finalTokens: 0,
        truncated: false,
        droppedReason: decision.droppedReason,
      };
    }

    if (!this.isContextBudgetEnabled()) {
      return {
        accepted: true,
        text: decision.finalText,
        originalTokens: decision.originalTokens,
        finalTokens: decision.finalTokens,
        truncated: decision.truncated,
      };
    }

    const scopeKey = this.buildInjectionScopeKey(sessionId, injectionScopeId);
    const usedTokens = this.sessionState.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
    const maxTokens = Math.max(
      0,
      Math.floor(this.config.infrastructure.contextBudget.maxInjectionTokens),
    );
    const remainingTokens = Math.max(0, maxTokens - usedTokens);
    if (remainingTokens <= 0) {
      return {
        accepted: false,
        text: "",
        originalTokens: decision.originalTokens,
        finalTokens: 0,
        truncated: false,
        droppedReason: "budget_exhausted",
      };
    }

    let finalText = decision.finalText;
    let finalTokens = decision.finalTokens;
    let truncated = decision.truncated;
    if (finalTokens > remainingTokens) {
      finalText = truncateTextToTokenBudget(finalText, remainingTokens);
      finalTokens = estimateTokenCount(finalText);
      truncated = true;
    }

    if (finalText.length === 0 || finalTokens <= 0) {
      return {
        accepted: false,
        text: "",
        originalTokens: decision.originalTokens,
        finalTokens: 0,
        truncated: false,
        droppedReason: "budget_exhausted",
      };
    }

    return {
      accepted: true,
      text: finalText,
      originalTokens: decision.originalTokens,
      finalTokens,
      truncated,
    };
  }

  commitSupplementalContextInjection(
    sessionId: string,
    finalTokens: number,
    injectionScopeId?: string,
  ): void {
    if (!this.isContextBudgetEnabled()) {
      return;
    }

    const normalizedTokens = Math.max(0, Math.floor(finalTokens));
    if (normalizedTokens <= 0) return;

    const scopeKey = this.buildInjectionScopeKey(sessionId, injectionScopeId);
    const usedTokens = this.sessionState.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
    const maxTokens = Math.max(
      0,
      Math.floor(this.config.infrastructure.contextBudget.maxInjectionTokens),
    );
    this.sessionState.reservedContextInjectionTokensByScope.set(
      scopeKey,
      Math.min(maxTokens, usedTokens + normalizedTokens),
    );
  }

  shouldRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean {
    return this.contextPressure.shouldRequestCompaction(sessionId, usage);
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
    this.contextPressure.markCompacted(sessionId);
    this.contextInjection.onCompaction(sessionId);
    this.clearInjectionFingerprintsForSession(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);

    const turn = this.getCurrentTurn(sessionId);
    const summary = input.summary?.trim();
    const entryId = input.entryId?.trim();
    if (summary) {
      this.sessionState.latestCompactionSummaryBySession.set(sessionId, {
        entryId,
        summary,
      });
    } else {
      this.sessionState.latestCompactionSummaryBySession.delete(sessionId);
    }

    this.recordEvent({
      sessionId,
      type: "context_compacted",
      turn,
      payload: {
        fromTokens: input.fromTokens ?? null,
        toTokens: input.toTokens ?? null,
        entryId: entryId ?? null,
        summaryChars: summary?.length ?? null,
      },
    });
    this.ledger.append({
      sessionId,
      turn,
      skill: this.getActiveSkill(sessionId)?.name,
      tool: "brewva_context_compaction",
      argsSummary: "context_compaction",
      outputSummary: `from=${input.fromTokens ?? "unknown"} to=${input.toTokens ?? "unknown"}`,
      fullOutput: JSON.stringify({
        fromTokens: input.fromTokens ?? null,
        toTokens: input.toTokens ?? null,
      }),
      verdict: "inconclusive",
      metadata: {
        source: "context_budget",
        fromTokens: input.fromTokens ?? null,
        toTokens: input.toTokens ?? null,
        entryId: entryId ?? null,
        summaryChars: summary?.length ?? null,
      },
    });
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

  clearStabilityMonitorSession(sessionId: string): void {
    this.stabilityMonitor.clearSession(sessionId);
    this.contextStrategy.clearSession(sessionId);
  }

  private finalizeContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): {
    text: string;
    accepted: boolean;
    originalTokens: number;
    finalTokens: number;
    truncated: boolean;
  } {
    const strategyDecision = this.contextStrategy.resolve({ sessionId });

    return buildContextInjectionOrchestrated(
      {
        cwd: this.cwd,
        maxInjectionTokens: this.config.infrastructure.contextBudget.maxInjectionTokens,
        isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
        getToolFailureInjectionConfig: () => this.config.infrastructure.toolFailureInjection,
        sanitizeInput: (text) => this.sanitizeInput(text),
        getTruthState: (id) => this.getTruthState(id),
        maybeAlignTaskStatus: (orchestrationInput) => this.maybeAlignTaskStatus(orchestrationInput),
        getRecentToolFailures: (id) => this.getRecentToolFailures(id),
        getTaskState: (id) => this.getTaskState(id),
        buildTaskStateBlock: (state) => this.buildTaskStateBlock(state),
        prepareSkillDispatch: (dispatchInput) => this.prepareSkillDispatch(dispatchInput),
        buildSkillCandidateBlock: (selected) => this.buildSkillCandidateBlock(selected),
        buildSkillDispatchGateBlock: (decision) => this.buildSkillDispatchGateBlock(decision),
        registerContextInjection: (id, registerInput) =>
          this.registerContextInjection(id, registerInput),
        recordEvent: (eventInput) => this.recordEvent(eventInput),
        planContextInjection: (id, tokenBudget, planOptions) =>
          this.contextInjection.plan(id, tokenBudget, planOptions),
        commitContextInjection: (id, consumedKeys) =>
          this.contextInjection.commit(id, consumedKeys),
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
        shouldForceCriticalOnly: (id, decisionTurn) =>
          this.stabilityMonitor.shouldForceCriticalOnly(id, decisionTurn),
        recordStabilityDegraded: (id, decisionTurn) =>
          this.stabilityMonitor.recordDegraded(id, decisionTurn),
        recordStabilityNormal: (id, monitorOptions) =>
          this.stabilityMonitor.recordNormal(id, monitorOptions),
        shouldRequestCompactionOnFloorUnmet: () =>
          this.config.infrastructure.contextBudget.floorUnmetPolicy.requestCompaction,
        requestCompaction: (id, reason) => this.contextPressure.requestCompaction(id, reason),
      },
      {
        sessionId,
        prompt,
        usage,
        injectionScopeId,
        adaptiveZonesEnabled: strategyDecision.adaptiveZonesEnabled,
        stabilityMonitorEnabled: strategyDecision.stabilityMonitorEnabled,
      },
    );
  }

  private maybeWriteBackExternalRecall(
    sessionId: string,
    finalInjectionText: string,
    externalRecallOutcome: ExternalRecallInjectionOutcome | null,
  ): void {
    if (!externalRecallOutcome) return;

    if (finalInjectionText.includes("[ExternalRecall]")) {
      const writeback = this.memory.ingestExternalRecall({
        sessionId,
        query: externalRecallOutcome.query,
        defaultConfidence: this.config.memory.externalRecall.injectedConfidence,
        hits: externalRecallOutcome.hits.map((hit) => ({
          topic: hit.topic,
          excerpt: hit.excerpt,
          score: typeof hit.score === "number" ? hit.score : 0,
          confidence: hit.confidence,
          metadata: hit.metadata,
        })),
      });
      this.recordEvent({
        sessionId,
        type: "context_external_recall_injected",
        payload: {
          query: externalRecallOutcome.query,
          hitCount: externalRecallOutcome.hits.length,
          internalTopScore: externalRecallOutcome.internalTopScore,
          threshold: externalRecallOutcome.threshold,
          writebackUnits: writeback.upserted,
        },
      });
      return;
    }

    this.recordEvent({
      sessionId,
      type: "context_external_recall_skipped",
      payload: {
        reason: "filtered_out",
        query: externalRecallOutcome.query,
        hitCount: externalRecallOutcome.hits.length,
        internalTopScore: externalRecallOutcome.internalTopScore,
        threshold: externalRecallOutcome.threshold,
      },
    });
  }

  private ensureContextProfileEvents(sessionId: string): void {
    if (!this.sessionState.contextProfileSelectedBySession.has(sessionId)) {
      this.sessionState.contextProfileSelectedBySession.add(sessionId);
      this.recordEvent({
        sessionId,
        type: "context_profile_selected",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          profile: this.contextProfile,
        },
      });
    }

    if (this.contextProfile !== "simple") {
      return;
    }

    let ignored = this.sessionState.contextProfileIgnoredOptionsBySession.get(sessionId);
    if (!ignored) {
      ignored = new Set<string>();
      this.sessionState.contextProfileIgnoredOptionsBySession.set(sessionId, ignored);
    }

    for (const optionKey of SIMPLE_PROFILE_IGNORED_OPTION_KEYS) {
      if (ignored.has(optionKey)) continue;
      ignored.add(optionKey);
      this.recordEvent({
        sessionId,
        type: "context_profile_option_ignored",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          profile: "simple",
          optionKey,
        },
      });
    }
  }

  private resolveSessionModel(sessionId: string): string {
    const summary = this.getCostSummary(sessionId);
    const modelRows = Object.entries(summary.models);
    if (modelRows.length === 0) return "(unknown)";
    const top = modelRows.toSorted((left, right) => right[1].totalTokens - left[1].totalTokens)[0];
    return top?.[0] ?? "(unknown)";
  }

  private resolveTaskClass(sessionId: string): string {
    return this.getActiveSkill(sessionId)?.name ?? "(none)";
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

  private registerContextInjection(
    sessionId: string,
    input: {
      source: string;
      id: string;
      content: string;
      priority?: ContextInjectionPriority;
      estimatedTokens?: number;
      oncePerSession?: boolean;
    },
  ): ContextInjectionRegisterResult {
    const result = this.contextInjection.register(sessionId, input);
    if (result.sloEnforced) {
      this.recordEvent({
        sessionId,
        type: "context_arena_slo_enforced",
        payload: {
          policy: result.sloEnforced.policy,
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
