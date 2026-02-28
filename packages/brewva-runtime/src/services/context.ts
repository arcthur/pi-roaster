import { ContextBudgetManager } from "../context/budget.js";
import { ContextEvolutionManager } from "../context/evolution-manager.js";
import { readIdentityProfile } from "../context/identity.js";
import { buildContextInjection as buildContextInjectionOrchestrated } from "../context/injection-orchestrator.js";
import {
  ContextInjectionCollector,
  type ContextInjectionPriority,
  type ContextInjectionRegisterResult,
} from "../context/injection.js";
import { ContextStabilityMonitor } from "../context/stability-monitor.js";
import type { ToolFailureEntry } from "../context/tool-failures.js";
import type { ExternalRecallHit, ExternalRecallPort } from "../external-recall/types.js";
import { EvidenceLedger } from "../ledger/evidence-ledger.js";
import { MemoryEngine } from "../memory/engine.js";
import { FileChangeTracker } from "../state/file-change-tracker.js";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  ContextBudgetUsage,
  ContextCompactionReason,
  ContextCompactionGateStatus,
  BrewvaEventRecord,
  ContextPressureLevel,
  ContextPressureStatus,
  SessionCostSummary,
  SkillDocument,
  SkillSelection,
  TaskState,
  TruthState,
} from "../types.js";
import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

const OUTPUT_HEALTH_GUARD_LOOKBACK_EVENTS = 32;

interface ExternalRecallInjectionOutcome {
  query: string;
  hits: ExternalRecallHit[];
  internalTopScore: number | null;
  threshold: number;
}

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
  fileChanges: FileChangeTracker;
  ledger: EvidenceLedger;
  sessionState: RuntimeSessionStateStore;
  queryEvents: RuntimeCallback<[sessionId: string, query?: BrewvaEventQuery], BrewvaEventRecord[]>;
  listSessionIds: RuntimeCallback<[], string[]>;
  listEvents: RuntimeCallback<[sessionId: string, query?: BrewvaEventQuery], BrewvaEventRecord[]>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  getCostSummary: RuntimeCallback<[sessionId: string], SessionCostSummary>;
  selectSkills: RuntimeCallback<[message: string], SkillSelection[]>;
  buildSkillCandidateBlock: RuntimeCallback<[selected: SkillSelection[]], string>;
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
  getLedgerDigest: RuntimeCallback<[sessionId: string], string>;
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
  private readonly workspaceRoot: string;
  private readonly agentId: string;
  private readonly config: BrewvaConfig;
  private readonly contextBudget: ContextBudgetManager;
  private readonly contextInjection: ContextInjectionCollector;
  private readonly stabilityMonitor: ContextStabilityMonitor;
  private readonly memory: MemoryEngine;
  private readonly externalRecallPort?: ExternalRecallPort;
  private readonly fileChanges: FileChangeTracker;
  private readonly ledger: EvidenceLedger;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly queryEvents: (
    sessionId: string,
    query?: BrewvaEventQuery,
  ) => BrewvaEventRecord[];
  private readonly listSessionIds: () => string[];
  private readonly listEvents: (sessionId: string, query?: BrewvaEventQuery) => BrewvaEventRecord[];
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly getCostSummary: (sessionId: string) => SessionCostSummary;
  private readonly selectSkills: (message: string) => SkillSelection[];
  private readonly buildSkillCandidateBlock: (selected: SkillSelection[]) => string;
  private readonly buildTaskStateBlock: (state: TaskState) => string;
  private readonly maybeAlignTaskStatus: ContextServiceOptions["maybeAlignTaskStatus"];
  private readonly getLedgerDigest: (sessionId: string) => string;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly sanitizeInput: (text: string) => string;
  private readonly getFoldedToolFailures: (sessionId: string) => ToolFailureEntry[];
  private readonly recordEvent: ContextServiceOptions["recordEvent"];
  private readonly contextEvolution: ContextEvolutionManager;
  private readonly lastStrategyFingerprintBySession = new Map<string, string>();

  constructor(options: ContextServiceOptions) {
    this.cwd = options.cwd;
    this.workspaceRoot = options.workspaceRoot;
    this.agentId = options.agentId;
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.stabilityMonitor = options.stabilityMonitor;
    this.memory = options.memory;
    this.externalRecallPort = options.externalRecallPort;
    this.fileChanges = options.fileChanges;
    this.ledger = options.ledger;
    this.sessionState = options.sessionState;
    this.queryEvents = options.queryEvents;
    this.listSessionIds = options.listSessionIds;
    this.listEvents = options.listEvents;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.getCostSummary = options.getCostSummary;
    this.selectSkills = options.selectSkills;
    this.buildSkillCandidateBlock = options.buildSkillCandidateBlock;
    this.buildTaskStateBlock = options.buildTaskStateBlock;
    this.maybeAlignTaskStatus = options.maybeAlignTaskStatus;
    this.getLedgerDigest = options.getLedgerDigest;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkill = options.getActiveSkill;
    this.sanitizeInput = options.sanitizeInput;
    this.getFoldedToolFailures = options.getFoldedToolFailures;
    this.recordEvent = options.recordEvent;
    this.contextEvolution = new ContextEvolutionManager({
      config: this.config.infrastructure.contextBudget,
      workspaceRoot: this.workspaceRoot,
      listSessionIds: () => this.listSessionIds(),
      listEvents: (sessionId) => this.listEvents(sessionId),
    });
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

  private normalizeRatio(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value >= 0 && value <= 1) return value;
    if (value > 1 && value <= 100) return value / 100;
    if (value < 0) return 0;
    return 1;
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

  private resolveRecentCompactionWindowTurns(): number {
    return Math.max(1, this.config.infrastructure.contextBudget.compaction.minTurnsBetween);
  }

  getRecentCompactionWindowTurns(): number {
    return this.resolveRecentCompactionWindowTurns();
  }

  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus {
    const pressure = this.getContextPressureStatus(sessionId, usage);
    const windowTurns = this.resolveRecentCompactionWindowTurns();

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

  private getLatestOutputHealth(
    sessionId: string,
  ): { score: number; drunk: boolean; flags: string[] } | null {
    const recent = this.queryEvents(sessionId, {
      type: "message_update",
      last: OUTPUT_HEALTH_GUARD_LOOKBACK_EVENTS,
    });
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const event = recent[i];
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") continue;
      const health = (payload as { health?: unknown }).health;
      if (!health || typeof health !== "object") continue;
      const score = (health as { score?: unknown }).score;
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      const drunk = (health as { drunk?: unknown }).drunk === true;
      const flagsRaw = (health as { flags?: unknown }).flags;
      const flags = Array.isArray(flagsRaw)
        ? flagsRaw
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .slice(0, 8)
        : [];
      return { score, drunk, flags };
    }
    return null;
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

  private buildExternalRecallBlock(query: string, hits: ExternalRecallHit[]): string {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return "";
    const lines: string[] = ["[ExternalRecall]", `query: ${trimmedQuery}`];
    const normalizedHits = hits
      .map((hit) => ({
        topic: this.sanitizeInput(hit.topic).trim(),
        excerpt: this.sanitizeInput(hit.excerpt).trim(),
        score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : null,
        confidence:
          typeof hit.confidence === "number" && Number.isFinite(hit.confidence)
            ? hit.confidence
            : null,
      }))
      .filter((hit) => hit.topic.length > 0 && hit.excerpt.length > 0)
      .slice(0, 8);
    if (normalizedHits.length === 0) return "";
    normalizedHits.forEach((hit, index) => {
      const score = hit.score !== null ? ` score=${hit.score.toFixed(3)}` : "";
      const confidence = hit.confidence !== null ? ` conf=${hit.confidence.toFixed(3)}` : "";
      lines.push(`${index + 1}. ${hit.topic}${score}${confidence}`);
      lines.push(`   ${hit.excerpt}`);
    });
    return lines.join("\n");
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
    this.registerIdentityContextInjection(sessionId);
    const externalRecallOutcome = await this.registerMemoryContextInjection(
      sessionId,
      prompt,
      usage,
    );
    const finalized = this.finalizeContextInjection(sessionId, prompt, usage, injectionScopeId);

    if (externalRecallOutcome) {
      if (finalized.text.includes("[ExternalRecall]")) {
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
      } else {
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
    }

    return finalized;
  }

  private registerIdentityContextInjection(sessionId: string): void {
    let profile: ReturnType<typeof readIdentityProfile>;
    try {
      profile = readIdentityProfile({
        workspaceRoot: this.workspaceRoot,
        agentId: this.agentId,
      });
    } catch (error) {
      this.recordEvent({
        sessionId,
        type: "identity_parse_warning",
        payload: {
          agentId: this.agentId,
          reason: error instanceof Error ? error.message : "unknown_error",
        },
      });
      return;
    }
    if (!profile) return;

    const content = profile.content.trim();
    if (!content) return;
    this.registerContextInjection(sessionId, {
      source: "brewva.identity",
      id: `identity-${profile.agentId}`,
      priority: "critical",
      content,
      oncePerSession: true,
    });
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
    const strategyDecision = this.contextEvolution.resolve({
      sessionId,
      model: this.resolveSessionModel(sessionId),
      taskClass: this.resolveTaskClass(sessionId),
      contextWindow:
        typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow)
          ? usage.contextWindow
          : null,
    });
    if (!strategyDecision.stabilityMonitorEnabled) {
      // Prevent stale stabilized state from leaking across strategy/retirement transitions.
      this.stabilityMonitor.clearSession(sessionId);
    }
    const turn = this.getCurrentTurn(sessionId);
    for (const transition of strategyDecision.transitions) {
      this.recordEvent({
        sessionId,
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
      strategyDecision.armOverrideId ?? "",
      strategyDecision.adaptiveZonesEnabled ? "1" : "0",
      strategyDecision.stabilityMonitorEnabled ? "1" : "0",
      strategyDecision.model,
      strategyDecision.taskClass,
    ].join("|");
    const previousStrategyFingerprint = this.lastStrategyFingerprintBySession.get(sessionId);
    if (previousStrategyFingerprint !== strategyFingerprint) {
      this.lastStrategyFingerprintBySession.set(sessionId, strategyFingerprint);
      this.recordEvent({
        sessionId,
        turn,
        type: "context_strategy_selected",
        payload: {
          arm: strategyDecision.arm,
          source: strategyDecision.armSource,
          overrideId: strategyDecision.armOverrideId ?? null,
          adaptiveZonesEnabled: strategyDecision.adaptiveZonesEnabled,
          stabilityMonitorEnabled: strategyDecision.stabilityMonitorEnabled,
          model: strategyDecision.model,
          taskClass: strategyDecision.taskClass,
        },
      });
    }

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
        registerContextInjection: (id, registerInput) =>
          this.registerContextInjection(id, registerInput),
        recordEvent: (eventInput) => this.recordEvent(eventInput),
        planContextInjection: (id, tokenBudget, planOptions) =>
          this.contextInjection.plan(id, tokenBudget, planOptions),
        commitContextInjection: (id, consumedKeys) =>
          this.contextInjection.commit(id, consumedKeys),
        planBudgetInjection: (id, inputText, budgetUsage, budgetOptions) =>
          this.contextBudget.planInjection(id, inputText, budgetUsage, budgetOptions),
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
        requestCompaction: (id, reason) => this.requestCompaction(id, reason),
      },
      {
        sessionId,
        prompt,
        usage,
        injectionScopeId,
        strategyArm: strategyDecision.arm,
        adaptiveZonesEnabled: strategyDecision.adaptiveZonesEnabled,
        stabilityMonitorEnabled: strategyDecision.stabilityMonitorEnabled,
      },
    );
  }

  private async registerMemoryContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
  ): Promise<ExternalRecallInjectionOutcome | null> {
    if (!this.config.memory.enabled) return null;
    const taskGoal = this.getTaskState(sessionId).spec?.goal;
    this.memory.refreshIfNeeded({ sessionId });

    const working = this.memory.getWorkingMemory(sessionId);
    const workingContent = working?.content.trim() ?? "";
    if (workingContent) {
      this.registerContextInjection(sessionId, {
        source: "brewva.memory-working",
        id: "memory-working",
        priority: "critical",
        content: workingContent,
      });
    }

    const recallMode = this.config.memory.recallMode ?? "primary";
    let shouldIncludeRecall = true;
    if (recallMode === "fallback") {
      const pressureLevel = this.getContextPressureLevel(sessionId, usage);
      if (pressureLevel === "high" || pressureLevel === "critical") {
        shouldIncludeRecall = false;
      }
    }

    const openInsightTerms = this.memory.getOpenInsightTerms(sessionId, 8);
    const recallQuery = [taskGoal, prompt, ...openInsightTerms].filter(Boolean).join("\n");
    if (openInsightTerms.length > 0) {
      this.recordEvent({
        sessionId,
        type: "memory_recall_query_expanded",
        payload: {
          terms: openInsightTerms,
          termsCount: openInsightTerms.length,
        },
      });
    }
    let recallContent = "";
    if (shouldIncludeRecall) {
      const recall = await this.memory.buildRecallBlock({
        sessionId,
        query: recallQuery,
        limit: this.config.memory.retrievalTopK,
      });
      recallContent = recall.trim();
    }

    if (recallContent) {
      this.registerContextInjection(sessionId, {
        source: "brewva.memory-recall",
        id: "memory-recall",
        priority: "normal",
        content: recallContent,
      });
    }

    const externalRecallConfig = this.config.memory.externalRecall;
    const activeSkill = this.getActiveSkill(sessionId);
    const isExternalKnowledgeSkill =
      activeSkill?.contract.tags.some((tag) => tag === "external-knowledge") === true;
    if (!externalRecallConfig.enabled) {
      return null;
    }
    if (!isExternalKnowledgeSkill) {
      this.recordEvent({
        sessionId,
        type: "context_external_recall_skipped",
        payload: {
          reason: "skill_tag_missing",
          query: recallQuery,
          threshold: externalRecallConfig.minInternalScore,
        },
      });
      return null;
    }

    const probe = await this.memory.search(sessionId, {
      query: recallQuery,
      limit: 1,
    });
    const internalTopScore = probe.hits[0]?.score ?? null;
    const triggerExternalRecall =
      internalTopScore === null || internalTopScore < externalRecallConfig.minInternalScore;
    if (!triggerExternalRecall) {
      this.recordEvent({
        sessionId,
        type: "context_external_recall_skipped",
        payload: {
          reason: "internal_score_sufficient",
          query: recallQuery,
          internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      });
      return null;
    }

    if (!this.externalRecallPort) {
      this.recordEvent({
        sessionId,
        type: "context_external_recall_skipped",
        payload: {
          reason: "provider_unavailable",
          query: recallQuery,
          internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      });
      return null;
    }

    const externalHits = await this.externalRecallPort.search({
      sessionId,
      query: recallQuery,
      limit: externalRecallConfig.queryTopK,
    });
    if (!externalHits.length) {
      this.recordEvent({
        sessionId,
        type: "context_external_recall_skipped",
        payload: {
          reason: "no_hits",
          query: recallQuery,
          internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      });
      return null;
    }

    const externalBlock = this.buildExternalRecallBlock(recallQuery, externalHits);
    if (!externalBlock) {
      this.recordEvent({
        sessionId,
        type: "context_external_recall_skipped",
        payload: {
          reason: "empty_block",
          query: recallQuery,
          hitCount: externalHits.length,
        },
      });
      return null;
    }

    const externalRegistration = this.registerContextInjection(sessionId, {
      source: "brewva.rag-external",
      id: "rag-external",
      priority: "normal",
      content: externalBlock,
    });
    if (!externalRegistration.accepted) {
      this.recordEvent({
        sessionId,
        type: "context_external_recall_skipped",
        payload: {
          reason: "arena_rejected",
          query: recallQuery,
          hitCount: externalHits.length,
          internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
          degradationPolicy: externalRegistration.sloEnforced?.policy ?? null,
        },
      });
      return null;
    }

    return {
      query: recallQuery,
      hits: externalHits,
      internalTopScore,
      threshold: externalRecallConfig.minInternalScore,
    };
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

  markContextCompacted(
    sessionId: string,
    input: {
      fromTokens?: number | null;
      toTokens?: number | null;
      summary?: string;
      entryId?: string;
    },
  ): void {
    this.contextBudget.markCompacted(sessionId);
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
    this.lastStrategyFingerprintBySession.delete(sessionId);
  }
}
