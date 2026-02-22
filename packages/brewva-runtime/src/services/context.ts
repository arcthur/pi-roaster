import { ContextBudgetManager } from "../context/budget.js";
import { buildContextInjection as buildContextInjectionOrchestrated } from "../context/injection-orchestrator.js";
import { ContextInjectionCollector, type ContextInjectionPriority } from "../context/injection.js";
import { EvidenceLedger } from "../ledger/evidence-ledger.js";
import { MemoryEngine } from "../memory/engine.js";
import { FileChangeTracker } from "../state/file-change-tracker.js";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextPressureLevel,
  ContextPressureStatus,
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

export interface ContextServiceOptions {
  cwd: string;
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  contextInjection: ContextInjectionCollector;
  memory: MemoryEngine;
  fileChanges: FileChangeTracker;
  ledger: EvidenceLedger;
  sessionState: RuntimeSessionStateStore;
  queryEvents: RuntimeCallback<[sessionId: string, query?: BrewvaEventQuery], BrewvaEventRecord[]>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
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
  private readonly memory: MemoryEngine;
  private readonly fileChanges: FileChangeTracker;
  private readonly ledger: EvidenceLedger;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly queryEvents: (
    sessionId: string,
    query?: BrewvaEventQuery,
  ) => BrewvaEventRecord[];
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly selectSkills: (message: string) => SkillSelection[];
  private readonly buildSkillCandidateBlock: (selected: SkillSelection[]) => string;
  private readonly buildTaskStateBlock: (state: TaskState) => string;
  private readonly maybeAlignTaskStatus: ContextServiceOptions["maybeAlignTaskStatus"];
  private readonly getLedgerDigest: (sessionId: string) => string;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly sanitizeInput: (text: string) => string;
  private readonly recordEvent: ContextServiceOptions["recordEvent"];

  constructor(options: ContextServiceOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.contextInjection = options.contextInjection;
    this.memory = options.memory;
    this.fileChanges = options.fileChanges;
    this.ledger = options.ledger;
    this.sessionState = options.sessionState;
    this.queryEvents = options.queryEvents;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.selectSkills = options.selectSkills;
    this.buildSkillCandidateBlock = options.buildSkillCandidateBlock;
    this.buildTaskStateBlock = options.buildTaskStateBlock;
    this.maybeAlignTaskStatus = options.maybeAlignTaskStatus;
    this.getLedgerDigest = options.getLedgerDigest;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkill = options.getActiveSkill;
    this.sanitizeInput = options.sanitizeInput;
    this.recordEvent = options.recordEvent;
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
    const raw = this.config.infrastructure.contextBudget.minTurnsBetweenCompaction;
    if (!Number.isFinite(raw)) return 1;
    return Math.max(1, Math.floor(raw));
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
    const required =
      this.config.infrastructure.contextBudget.enabled &&
      pressure.level === "critical" &&
      !recentCompaction;

    return {
      required,
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
      "Context usage is critical. Call tool 'session_compact' first, then continue with other tools.";
    this.recordEvent({
      sessionId,
      type: "context_compaction_gate_blocked_tool",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        blockedTool: toolName,
        reason: "critical_context_pressure_without_compaction",
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

  buildContextInjection(
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
    if (this.config.memory.enabled) {
      const taskGoal = this.getTaskState(sessionId).spec?.goal;
      this.memory.refreshIfNeeded({ sessionId });

      const working = this.memory.getWorkingMemory(sessionId);
      if (working?.content.trim()) {
        this.registerContextInjection(sessionId, {
          source: "brewva.working-memory",
          id: "working-memory",
          priority: "critical",
          content: working.content,
        });
      }

      const recallQuery = [taskGoal, prompt].filter(Boolean).join("\n");
      const recall = this.memory.buildRecallBlock({
        sessionId,
        query: recallQuery,
        limit: this.config.memory.retrievalTopK,
      });
      if (recall.trim()) {
        this.registerContextInjection(sessionId, {
          source: "brewva.memory-recall",
          id: "memory-recall",
          priority: "high",
          content: recall,
        });
      }
    }

    return buildContextInjectionOrchestrated(
      {
        cwd: this.cwd,
        maxInjectionTokens: this.config.infrastructure.contextBudget.maxInjectionTokens,
        isContextBudgetEnabled: () => this.isContextBudgetEnabled(),
        sanitizeInput: (text) => this.sanitizeInput(text),
        getTruthState: (id) => this.getTruthState(id),
        maybeAlignTaskStatus: (orchestrationInput) => this.maybeAlignTaskStatus(orchestrationInput),
        getLatestOutputHealth: (id) => this.getLatestOutputHealth(id),
        selectSkills: (text) => this.selectSkills(text),
        buildSkillCandidateBlock: (selected) => this.buildSkillCandidateBlock(selected),
        getLedgerDigest: (id) => this.getLedgerDigest(id),
        getLatestCompactionSummary: (id) =>
          this.sessionState.latestCompactionSummaryBySession.get(id),
        getTaskState: (id) => this.getTaskState(id),
        buildTaskStateBlock: (state) => this.buildTaskStateBlock(state),
        recentFiles: (id, limit) => this.fileChanges.recentFiles(id, limit),
        setViewportPolicy: (id, policy) =>
          this.sessionState.viewportPolicyBySession.set(id, policy),
        registerContextInjection: (id, registerInput) =>
          this.registerContextInjection(id, registerInput),
        getCurrentTurn: (id) => this.getCurrentTurn(id),
        recordEvent: (eventInput) => this.recordEvent(eventInput),
        planContextInjection: (id, tokenBudget) => this.contextInjection.plan(id, tokenBudget),
        commitContextInjection: (id, consumedKeys) =>
          this.contextInjection.commit(id, consumedKeys),
        planBudgetInjection: (id, inputText, budgetUsage) =>
          this.contextBudget.planInjection(id, inputText, budgetUsage),
        buildInjectionScopeKey: (id, scopeId) => this.buildInjectionScopeKey(id, scopeId),
        getReservedTokens: (scopeKey) =>
          this.sessionState.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0,
        setReservedTokens: (scopeKey, tokens) =>
          this.sessionState.reservedContextInjectionTokensByScope.set(scopeKey, tokens),
        getLastInjectedFingerprint: (scopeKey) =>
          this.sessionState.lastInjectedContextFingerprintBySession.get(scopeKey),
        setLastInjectedFingerprint: (scopeKey, fingerprint) =>
          this.sessionState.lastInjectedContextFingerprintBySession.set(scopeKey, fingerprint),
      },
      {
        sessionId,
        prompt,
        usage,
        injectionScopeId,
      },
    );
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
    this.recordEvent({
      sessionId,
      type: "context_compaction_requested",
      payload: {
        reason: decision.reason ?? "usage_threshold",
        usagePercent: decision.usage?.percent ?? null,
        tokens: decision.usage?.tokens ?? null,
      },
    });
    return true;
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
    this.contextInjection.resetOncePerSession(sessionId);
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
  ): void {
    this.contextInjection.register(sessionId, input);
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
}
