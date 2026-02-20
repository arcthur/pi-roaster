import { resolve } from "node:path";
import { loadBrewvaConfigWithDiagnostics, type BrewvaConfigDiagnostic } from "./config/loader.js";
import { resolveWorkspaceRootDir } from "./config/paths.js";
import { ContextBudgetManager } from "./context/budget.js";
import { buildContextInjection as buildContextInjectionOrchestrated } from "./context/injection-orchestrator.js";
import { ContextInjectionCollector, type ContextInjectionPriority } from "./context/injection.js";
import { SessionCostTracker } from "./cost/tracker.js";
import { BrewvaEventStore } from "./events/store.js";
import { buildLedgerDigest } from "./ledger/digest.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { formatLedgerRows } from "./ledger/query.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import type { ViewportQuality } from "./policy/viewport-policy.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { checkToolAccess } from "./security/tool-policy.js";
import { SkillRegistry } from "./skills/registry.js";
import { selectTopKSkills } from "./skills/selector.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
  coerceTapeAnchorPayload,
} from "./tape/events.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import {
  TASK_EVENT_TYPE,
  buildBlockerRecordedEvent,
  buildBlockerResolvedEvent,
  buildStatusSetEvent,
  buildItemAddedEvent,
  buildItemUpdatedEvent,
  formatTaskStateBlock,
} from "./task/ledger.js";
import { normalizeTaskSpec } from "./task/spec.js";
import {
  TRUTH_EVENT_TYPE,
  buildTruthFactResolvedEvent,
  buildTruthFactUpsertedEvent,
} from "./truth/ledger.js";
import { syncTruthFromToolResult } from "./truth/sync.js";
import type {
  ContextPressureLevel,
  ContextPressureStatus,
  ContextCompactionGateStatus,
  ContextBudgetUsage,
  EvidenceQuery,
  ParallelAcquireResult,
  RollbackResult,
  BrewvaEventCategory,
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaConfig,
  BrewvaStructuredEvent,
  SkillDocument,
  SkillOutputRecord,
  SkillSelection,
  SessionCostSummary,
  TapePressureLevel,
  TapeSearchMatch,
  TapeSearchResult,
  TapeSearchScope,
  TapeStatusState,
  TaskSpec,
  TaskState,
  VerificationLevel,
  VerificationReport,
  VerificationCheckRun,
  WorkerMergeReport,
  WorkerResult,
} from "./types.js";
import type { TaskItemStatus } from "./types.js";
import type { TaskHealth, TaskPhase, TaskStatus } from "./types.js";
import type { TruthFact, TruthFactSeverity, TruthFactStatus, TruthState } from "./types.js";
import { runShellCommand } from "./utils/exec.js";
import { normalizeJsonRecord } from "./utils/json.js";
import { normalizePercent } from "./utils/token.js";
import { estimateTokenCount, truncateTextToTokenBudget } from "./utils/token.js";
import { normalizeToolName } from "./utils/tool-name.js";
import { classifyEvidence, isMutationTool } from "./verification/classifier.js";
import { VerificationGate } from "./verification/gate.js";

const ALWAYS_ALLOWED_TOOLS = [
  "skill_complete",
  "skill_load",
  "ledger_query",
  "cost_view",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "session_compact",
  "rollback_last_patch",
];
const ALWAYS_ALLOWED_TOOL_SET = new Set(ALWAYS_ALLOWED_TOOLS);
const OUTPUT_HEALTH_GUARD_LOOKBACK_EVENTS = 32;

const VERIFIER_BLOCKER_PREFIX = "verifier:" as const;

function normalizeVerifierCheckForId(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/[^a-z0-9._-]+/g, "-");
}

function buildVerifierBlockerMessage(input: {
  checkName: string;
  truthFactId: string;
  run?: VerificationCheckRun;
}): string {
  const parts: string[] = [`verification failed: ${input.checkName}`, `truth=${input.truthFactId}`];
  if (input.run?.ledgerId) {
    parts.push(`evidence=${input.run.ledgerId}`);
  }
  if (input.run && input.run.exitCode !== null && input.run.exitCode !== undefined) {
    parts.push(`exitCode=${input.run.exitCode}`);
  }
  return parts.join(" ");
}

export interface BrewvaRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

function inferEventCategory(type: string): BrewvaEventCategory {
  if (type === TAPE_ANCHOR_EVENT_TYPE || type === TAPE_CHECKPOINT_EVENT_TYPE) {
    return "state";
  }
  if (type.startsWith("session_") || type === "session_start" || type === "session_shutdown")
    return "session";
  if (type.startsWith("turn_")) return "turn";
  if (type.includes("tool") || type.startsWith("patch_") || type === "rollback") return "tool";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("cost_") || type.startsWith("budget_")) return "cost";
  if (type.startsWith("verification_")) return "verification";
  if (type.includes("snapshot") || type.includes("resumed") || type.includes("interrupted"))
    return "state";
  return "other";
}

function buildSkillCandidateBlock(selected: SkillSelection[]): string {
  const skillLines =
    selected.length > 0
      ? selected.map((entry) => `- ${entry.name} (score=${entry.score}, reason=${entry.reason})`)
      : ["- (none)"];
  return ["[Brewva Context]", "Top-K Skill Candidates:", ...skillLines].join("\n");
}

function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}

function buildContextSourceTokenLimits(maxInjectionTokens: number): Record<string, number> {
  const budget = Math.max(64, Math.floor(maxInjectionTokens));
  const fromRatio = (ratio: number, minimum: number, maximum = budget): number => {
    const scaled = Math.floor(budget * ratio);
    return Math.max(minimum, Math.min(maximum, scaled));
  };

  return {
    "brewva.truth": fromRatio(0.05, 48, 200),
    "brewva.truth-facts": fromRatio(0.12, 72, 320),
    "brewva.viewport-policy": fromRatio(0.12, 96, 320),
    "brewva.task-state": fromRatio(0.15, 96, 360),
    "brewva.viewport": fromRatio(0.7, 240, budget),
    "brewva.skill-candidates": fromRatio(0.28, 64, 320),
    "brewva.compaction-summary": fromRatio(0.45, 120, 600),
    "brewva.ledger-digest": fromRatio(0.2, 96, 360),
  };
}

export class BrewvaRuntime {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly config: BrewvaConfig;
  readonly configDiagnostics: BrewvaConfigDiagnostic[];
  readonly skills: SkillRegistry;
  readonly ledger: EvidenceLedger;
  readonly verification: VerificationGate;
  readonly parallel: ParallelBudgetManager;
  readonly parallelResults: ParallelResultStore;
  readonly events: BrewvaEventStore;
  readonly contextBudget: ContextBudgetManager;
  readonly contextInjection: ContextInjectionCollector;
  readonly fileChanges: FileChangeTracker;
  readonly costTracker: SessionCostTracker;

  private activeSkillsBySession = new Map<string, string>();
  private turnsBySession = new Map<string, number>();
  private toolCallsBySession = new Map<string, number>();
  private latestCompactionSummaryBySession = new Map<
    string,
    { entryId?: string; summary: string }
  >();
  private lastInjectedContextFingerprintBySession = new Map<string, string>();
  private reservedContextInjectionTokensByScope = new Map<string, number>();
  private lastLedgerCompactionTurnBySession = new Map<string, number>();
  private toolContractWarningsBySession = new Map<string, Set<string>>();
  private skillBudgetWarningsBySession = new Map<string, Set<string>>();
  private skillParallelWarningsBySession = new Map<string, Set<string>>();
  private skillOutputsBySession = new Map<string, Map<string, SkillOutputRecord>>();
  private turnReplay: TurnReplayEngine;
  private viewportPolicyBySession = new Map<
    string,
    {
      quality: ViewportQuality;
      score: number | null;
      variant: string;
      updatedAt: number;
    }
  >();
  private tapeCheckpointWriteInProgressBySession = new Set<string>();
  private eventListeners = new Set<(event: BrewvaStructuredEvent) => void>();

  constructor(options: BrewvaRuntimeOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.workspaceRoot = resolveWorkspaceRootDir(this.cwd);
    if (options.config) {
      this.config = options.config;
      this.configDiagnostics = [];
    } else {
      const loaded = loadBrewvaConfigWithDiagnostics({
        cwd: this.cwd,
        configPath: options.configPath,
      });
      this.config = loaded.config;
      this.configDiagnostics = loaded.diagnostics;
    }

    this.skills = new SkillRegistry({
      rootDir: this.cwd,
      config: this.config,
    });
    this.skills.load();
    this.skills.writeIndex();

    const ledgerPath = resolve(this.workspaceRoot, this.config.ledger.path);
    this.ledger = new EvidenceLedger(ledgerPath);
    this.verification = new VerificationGate(this.config);
    this.parallel = new ParallelBudgetManager(this.config.parallel);
    this.parallelResults = new ParallelResultStore();
    this.events = new BrewvaEventStore(this.config.infrastructure.events, this.workspaceRoot);
    this.contextBudget = new ContextBudgetManager(this.config.infrastructure.contextBudget);
    this.contextInjection = new ContextInjectionCollector({
      sourceTokenLimits: this.isContextBudgetEnabled()
        ? buildContextSourceTokenLimits(this.config.infrastructure.contextBudget.maxInjectionTokens)
        : {},
      truncationStrategy: this.config.infrastructure.contextBudget.truncationStrategy,
    });
    this.turnReplay = new TurnReplayEngine({
      listEvents: (sessionId) => this.queryEvents(sessionId),
      getTurn: (sessionId) => this.getCurrentTurn(sessionId),
    });
    this.fileChanges = new FileChangeTracker(this.cwd, {
      artifactsBaseDir: this.workspaceRoot,
    });
    this.costTracker = new SessionCostTracker(this.config.infrastructure.costTracking);
  }

  refreshSkills(): void {
    this.skills.load();
    this.skills.writeIndex();
  }

  listSkills(): SkillDocument[] {
    return this.skills.list();
  }

  getSkill(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  selectSkills(message: string): SkillSelection[] {
    const input = this.config.security.sanitizeContext ? sanitizeContextText(message) : message;
    return selectTopKSkills(input, this.skills.buildIndex(), this.config.skills.selector.k);
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    const current = this.turnsBySession.get(sessionId) ?? 0;
    const effectiveTurn = Math.max(current, turnIndex);
    this.turnsBySession.set(sessionId, effectiveTurn);
    this.contextBudget.beginTurn(sessionId, effectiveTurn);
    this.contextInjection.clearPending(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
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

  private isSameTaskStatus(left: TaskStatus | undefined, right: TaskStatus): boolean {
    if (!left) return false;
    if (left.phase !== right.phase) return false;
    if (left.health !== right.health) return false;
    if ((left.reason ?? "") !== (right.reason ?? "")) return false;

    const leftTruth = left.truthFactIds ?? [];
    const rightTruth = right.truthFactIds ?? [];
    if (leftTruth.length !== rightTruth.length) return false;
    for (let i = 0; i < leftTruth.length; i += 1) {
      if (leftTruth[i] !== rightTruth[i]) return false;
    }
    return true;
  }

  private computeTaskStatus(input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }): TaskStatus {
    const state = this.getTaskState(input.sessionId);
    const hasSpec = Boolean(state.spec);
    const blockers = state.blockers ?? [];
    const items = state.items ?? [];
    const openItems = items.filter((item) => item.status !== "done");

    const activeTruthFacts = input.truthState.facts.filter((fact) => fact.status === "active");
    const severityRank = (severity: string): number => {
      if (severity === "error") return 3;
      if (severity === "warn") return 2;
      return 1;
    };
    const truthFactIds = activeTruthFacts
      .toSorted((left, right) => {
        const severity = severityRank(right.severity) - severityRank(left.severity);
        if (severity !== 0) return severity;
        return right.lastSeenAt - left.lastSeenAt;
      })
      .slice(0, 6)
      .map((fact) => fact.id);

    let phase: TaskPhase = "align";
    let health: TaskHealth = "unknown";
    let reason: string | undefined;

    if (!hasSpec) {
      phase = "align";
      health = "needs_spec";
      reason = "task_spec_missing";
    } else if (blockers.length > 0) {
      phase = "blocked";
      const hasVerifier = blockers.some((blocker) =>
        blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX),
      );
      health = hasVerifier ? "verification_failed" : "blocked";
      reason = hasVerifier ? "verification_blockers_present" : "blockers_present";
    } else if (items.length === 0) {
      phase = "investigate";
      health = "ok";
      reason = "no_task_items";
    } else if (openItems.length > 0) {
      phase = "execute";
      health = "ok";
      reason = `open_items=${openItems.length}`;
    } else {
      const desiredLevel = state.spec?.verification?.level ?? this.config.verification.defaultLevel;
      const report = this.evaluateCompletion(input.sessionId, desiredLevel);
      phase = report.passed ? "done" : "verify";
      health = report.passed ? "ok" : "verification_failed";
      reason = report.passed
        ? "verification_passed"
        : report.missingEvidence.length > 0
          ? `missing_evidence=${report.missingEvidence.join(",")}`
          : "verification_missing";
    }

    if (health === "ok") {
      const ratio = normalizePercent(input.usage?.percent, {
        tokens: input.usage?.tokens,
        contextWindow: input.usage?.contextWindow,
      });
      if (ratio !== null && this.isContextBudgetEnabled()) {
        const threshold =
          normalizePercent(this.config.infrastructure.contextBudget.compactionThresholdPercent) ??
          1;
        const hardLimit =
          normalizePercent(this.config.infrastructure.contextBudget.hardLimitPercent) ?? 1;
        if (ratio >= hardLimit || ratio >= threshold) {
          health = "budget_pressure";
          reason = ratio >= hardLimit ? "context_hard_limit_pressure" : "context_usage_pressure";
        }
      }
    }

    return {
      phase,
      health,
      reason,
      updatedAt: Date.now(),
      truthFactIds: truthFactIds.length > 0 ? truthFactIds : undefined,
    };
  }

  private maybeAlignTaskStatus(input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }): void {
    const state = this.getTaskState(input.sessionId);
    const next = this.computeTaskStatus(input);
    if (this.isSameTaskStatus(state.status, next)) {
      return;
    }

    this.recordEvent({
      sessionId: input.sessionId,
      type: TASK_EVENT_TYPE,
      payload: buildStatusSetEvent(next) as unknown as Record<string, unknown>,
    });
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
        buildSkillCandidateBlock: (selected) => buildSkillCandidateBlock(selected),
        getLedgerDigest: (id) => this.getLedgerDigest(id),
        getLatestCompactionSummary: (id) => this.latestCompactionSummaryBySession.get(id),
        getTaskState: (id) => this.getTaskState(id),
        buildTaskStateBlock: (state) => buildTaskStateBlock(state),
        recentFiles: (id, limit) => this.fileChanges.recentFiles(id, limit),
        setViewportPolicy: (id, policy) => this.viewportPolicyBySession.set(id, policy),
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
          this.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0,
        setReservedTokens: (scopeKey, tokens) =>
          this.reservedContextInjectionTokensByScope.set(scopeKey, tokens),
        getLastInjectedFingerprint: (scopeKey) =>
          this.lastInjectedContextFingerprintBySession.get(scopeKey),
        setLastInjectedFingerprint: (scopeKey, fingerprint) =>
          this.lastInjectedContextFingerprintBySession.set(scopeKey, fingerprint),
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
    const usedTokens = this.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
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
    const usedTokens = this.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
    const maxTokens = Math.max(
      0,
      Math.floor(this.config.infrastructure.contextBudget.maxInjectionTokens),
    );
    this.reservedContextInjectionTokensByScope.set(
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
      this.latestCompactionSummaryBySession.set(sessionId, {
        entryId,
        summary,
      });
    } else {
      this.latestCompactionSummaryBySession.delete(sessionId);
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

  activateSkill(
    sessionId: string,
    name: string,
  ): { ok: boolean; reason?: string; skill?: SkillDocument } {
    const skill = this.skills.get(name);
    if (!skill) {
      return { ok: false, reason: `Skill '${name}' not found.` };
    }

    const activeName = this.activeSkillsBySession.get(sessionId);
    if (activeName && activeName !== name) {
      const activeSkill = this.skills.get(activeName);
      const activeAllows = activeSkill?.contract.composableWith?.includes(name) ?? false;
      const nextAllows = skill.contract.composableWith?.includes(activeName) ?? false;
      if (!activeAllows && !nextAllows) {
        return {
          ok: false,
          reason: `Active skill '${activeName}' must be completed before activating '${name}'.`,
        };
      }
    }

    this.activeSkillsBySession.set(sessionId, name);
    this.toolCallsBySession.set(sessionId, 0);
    return { ok: true, skill };
  }

  getActiveSkill(sessionId: string): SkillDocument | undefined {
    const active = this.activeSkillsBySession.get(sessionId);
    if (!active) return undefined;
    return this.skills.get(active);
  }

  validateSkillOutputs(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): { ok: boolean; missing: string[] } {
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return { ok: true, missing: [] };
    }

    const isSatisfied = (value: unknown): boolean => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value === "boolean") return true;
      if (typeof value === "object")
        return Object.keys(value as Record<string, unknown>).length > 0;
      return true;
    };

    const expected = skill.contract.outputs ?? [];
    const missing = expected.filter((name) => !isSatisfied(outputs[name]));
    if (missing.length === 0) {
      return { ok: true, missing: [] };
    }
    return { ok: false, missing };
  }

  validateComposePlan(plan: {
    steps: Array<{ skill: string; consumes?: string[]; produces?: string[] }>;
  }): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const availableOutputs = new Set<string>();

    for (const [i, step] of plan.steps.entries()) {
      const skill = this.skills.get(step.skill);
      if (!skill) {
        errors.push(`Step ${i + 1}: skill '${step.skill}' not found in registry.`);
        continue;
      }

      for (const consumed of step.consumes ?? []) {
        if (!availableOutputs.has(consumed)) {
          warnings.push(
            `Step ${i + 1} (${step.skill}): consumes '${consumed}' but no prior step produces it.`,
          );
        }
      }

      for (const produced of step.produces ?? []) {
        availableOutputs.add(produced);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  completeSkill(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): { ok: boolean; missing: string[] } {
    const validation = this.validateSkillOutputs(sessionId, outputs);
    if (!validation.ok) {
      return validation;
    }

    const activeSkillName = this.activeSkillsBySession.get(sessionId);
    if (activeSkillName) {
      let sessionOutputs = this.skillOutputsBySession.get(sessionId);
      if (!sessionOutputs) {
        sessionOutputs = new Map();
        this.skillOutputsBySession.set(sessionId, sessionOutputs);
      }
      sessionOutputs.set(activeSkillName, {
        skillName: activeSkillName,
        completedAt: Date.now(),
        outputs,
      });

      this.activeSkillsBySession.delete(sessionId);
      this.toolCallsBySession.delete(sessionId);
    }
    return validation;
  }

  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined {
    return this.skillOutputsBySession.get(sessionId)?.get(skillName)?.outputs;
  }

  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
    const targetSkill = this.skills.get(targetSkillName);
    if (!targetSkill) return {};
    const consumes = targetSkill.contract.consumes ?? [];
    if (consumes.length === 0) return {};

    const consumeSet = new Set(consumes);
    const result: Record<string, unknown> = {};
    const sessionOutputs = this.skillOutputsBySession.get(sessionId);
    if (!sessionOutputs) return {};

    for (const record of sessionOutputs.values()) {
      for (const [key, value] of Object.entries(record.outputs)) {
        if (consumeSet.has(key)) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  checkToolAccess(sessionId: string, toolName: string): { allowed: boolean; reason?: string } {
    const skill = this.getActiveSkill(sessionId);
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      const reason = `Tool '${normalizedToolName}' has been removed. Use 'exec' with 'process' for command execution.`;
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason,
        },
      });
      return { allowed: false, reason };
    }

    const access = checkToolAccess(skill?.contract, toolName, {
      enforceDeniedTools: this.config.security.enforceDeniedTools,
      allowedToolsMode: this.config.security.allowedToolsMode,
      alwaysAllowedTools: ALWAYS_ALLOWED_TOOLS,
    });

    if (access.warning && skill) {
      const key = `${skill.name}:${normalizedToolName}`;
      const seen = this.toolContractWarningsBySession.get(sessionId) ?? new Set<string>();
      if (!seen.has(key)) {
        seen.add(key);
        this.toolContractWarningsBySession.set(sessionId, seen);
        this.recordEvent({
          sessionId,
          type: "tool_contract_warning",
          turn: this.getCurrentTurn(sessionId),
          payload: {
            skill: skill.name,
            toolName: normalizedToolName,
            mode: this.config.security.allowedToolsMode,
            reason: access.warning,
          },
        });
      }
    }

    if (!access.allowed) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason: access.reason ?? "Tool call blocked.",
        },
      });
      return { allowed: false, reason: access.reason };
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    if (budget.blocked && !ALWAYS_ALLOWED_TOOL_SET.has(normalizedToolName)) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason: budget.reason ?? "Session budget exceeded.",
        },
      });
      return {
        allowed: false,
        reason: budget.reason ?? "Session budget exceeded.",
      };
    }

    if (!skill) {
      return access;
    }

    if (
      this.config.security.skillMaxTokensMode !== "off" &&
      !ALWAYS_ALLOWED_TOOL_SET.has(normalizedToolName)
    ) {
      const maxTokens = skill.contract.budget.maxTokens;
      const usedTokens = this.costTracker.getSkillTotalTokens(sessionId, skill.name);
      if (usedTokens >= maxTokens) {
        const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
        if (this.config.security.skillMaxTokensMode === "warn") {
          const key = `maxTokens:${skill.name}`;
          const seen = this.skillBudgetWarningsBySession.get(sessionId) ?? new Set<string>();
          if (!seen.has(key)) {
            seen.add(key);
            this.skillBudgetWarningsBySession.set(sessionId, seen);
            this.recordEvent({
              sessionId,
              type: "skill_budget_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                usedTokens,
                maxTokens,
                budget: "tokens",
                mode: this.config.security.skillMaxTokensMode,
              },
            });
          }
        } else if (this.config.security.skillMaxTokensMode === "enforce") {
          this.recordEvent({
            sessionId,
            type: "tool_call_blocked",
            turn: this.getCurrentTurn(sessionId),
            payload: {
              toolName: normalizedToolName,
              skill: skill.name,
              reason,
            },
          });
          return { allowed: false, reason };
        }
      }
    }

    if (
      this.config.security.skillMaxToolCallsMode !== "off" &&
      !ALWAYS_ALLOWED_TOOL_SET.has(normalizedToolName)
    ) {
      const maxToolCalls = skill.contract.budget.maxToolCalls;
      const usedCalls = this.toolCallsBySession.get(sessionId) ?? 0;
      if (usedCalls >= maxToolCalls) {
        const reason = `Skill '${skill.name}' exceeded maxToolCalls=${maxToolCalls} (used=${usedCalls}).`;
        if (this.config.security.skillMaxToolCallsMode === "warn") {
          const key = `maxToolCalls:${skill.name}`;
          const seen = this.skillBudgetWarningsBySession.get(sessionId) ?? new Set<string>();
          if (!seen.has(key)) {
            seen.add(key);
            this.skillBudgetWarningsBySession.set(sessionId, seen);
            this.recordEvent({
              sessionId,
              type: "skill_budget_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                usedToolCalls: usedCalls,
                maxToolCalls,
                budget: "tool_calls",
                mode: this.config.security.skillMaxToolCallsMode,
              },
            });
          }
        } else if (this.config.security.skillMaxToolCallsMode === "enforce") {
          this.recordEvent({
            sessionId,
            type: "tool_call_blocked",
            turn: this.getCurrentTurn(sessionId),
            payload: {
              toolName: normalizedToolName,
              skill: skill.name,
              reason,
            },
          });
          return { allowed: false, reason };
        }
      }
    }

    return access;
  }

  startToolCall(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    usage?: ContextBudgetUsage;
    recordLifecycleEvent?: boolean;
  }): { allowed: boolean; reason?: string } {
    if (input.usage) {
      this.observeContextUsage(input.sessionId, input.usage);
    }

    if (input.recordLifecycleEvent) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
        },
      });
    }

    const access = this.checkToolAccess(input.sessionId, input.toolName);
    if (!access.allowed) return access;

    const compaction = this.checkContextCompactionGate(
      input.sessionId,
      input.toolName,
      input.usage,
    );
    if (!compaction.allowed) return compaction;

    this.markToolCall(input.sessionId, input.toolName);
    this.trackToolCallStart({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    });
    return { allowed: true };
  }

  finishToolCall(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    success: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }): string {
    const ledgerId = this.recordToolResult({
      sessionId: input.sessionId,
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      success: input.success,
      verdict: input.verdict,
      metadata: input.metadata,
    });
    this.trackToolCallEnd({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      success: input.success,
    });
    return ledgerId;
  }

  acquireParallelSlot(sessionId: string, runId: string): ParallelAcquireResult {
    const skill = this.getActiveSkill(sessionId);
    const maxParallel = skill?.contract.maxParallel;

    if (
      skill &&
      typeof maxParallel === "number" &&
      maxParallel > 0 &&
      this.config.security.skillMaxParallelMode !== "off"
    ) {
      const activeRuns = this.parallel.snapshotSession(sessionId)?.activeRunIds.length ?? 0;
      if (activeRuns >= maxParallel) {
        const mode = this.config.security.skillMaxParallelMode;
        if (mode === "warn") {
          const key = `maxParallel:${skill.name}`;
          const seen = this.skillParallelWarningsBySession.get(sessionId) ?? new Set<string>();
          if (!seen.has(key)) {
            seen.add(key);
            this.skillParallelWarningsBySession.set(sessionId, seen);
            this.recordEvent({
              sessionId,
              type: "skill_parallel_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                activeRuns,
                maxParallel,
                mode,
              },
            });
          }
        } else if (mode === "enforce") {
          this.recordEvent({
            sessionId,
            type: "parallel_slot_rejected",
            turn: this.getCurrentTurn(sessionId),
            payload: {
              runId,
              skill: skill.name,
              reason: "skill_max_parallel",
              activeRuns,
              maxParallel,
            },
          });
          return { accepted: false, reason: "skill_max_parallel" };
        }
      }
    }

    const acquired = this.parallel.acquire(sessionId, runId);
    if (!acquired.accepted) {
      this.recordEvent({
        sessionId,
        type: "parallel_slot_rejected",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          runId,
          skill: skill?.name ?? null,
          reason: acquired.reason ?? "unknown",
        },
      });
    }
    return acquired;
  }

  releaseParallelSlot(sessionId: string, runId: string): void {
    this.parallel.release(sessionId, runId);
  }

  markToolCall(sessionId: string, toolName: string): void {
    const current = this.toolCallsBySession.get(sessionId) ?? 0;
    const next = current + 1;
    this.toolCallsBySession.set(sessionId, next);
    this.costTracker.recordToolCall(sessionId, {
      toolName,
      turn: this.getCurrentTurn(sessionId),
    });
    if (isMutationTool(toolName)) {
      this.verification.stateStore.markWrite(sessionId);
    }
    this.recordEvent({
      sessionId,
      type: "tool_call_marked",
      turn: this.turnsBySession.get(sessionId),
      payload: {
        toolName,
        toolCalls: next,
      },
    });
  }

  trackToolCallStart(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): void {
    const capture = this.fileChanges.captureBeforeToolCall({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    });
    if (capture.trackedFiles.length === 0) {
      return;
    }
    this.recordEvent({
      sessionId: input.sessionId,
      type: "file_snapshot_captured",
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        files: capture.trackedFiles,
      },
    });
  }

  trackToolCallEnd(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    success: boolean;
  }): void {
    const patchSet = this.fileChanges.completeToolCall({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      success: input.success,
    });
    if (!patchSet) return;
    this.recordEvent({
      sessionId: input.sessionId,
      type: "patch_recorded",
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        patchSetId: patchSet.id,
        changes: patchSet.changes.map((change) => ({
          path: change.path,
          action: change.action,
        })),
      },
    });
  }

  rollbackLastPatchSet(sessionId: string): RollbackResult {
    const rollback = this.fileChanges.rollbackLast(sessionId);
    const turn = this.getCurrentTurn(sessionId);
    this.recordEvent({
      sessionId,
      type: "rollback",
      turn,
      payload: {
        ok: rollback.ok,
        patchSetId: rollback.patchSetId ?? null,
        restoredPaths: rollback.restoredPaths,
        failedPaths: rollback.failedPaths,
        reason: rollback.reason ?? null,
      },
    });

    if (!rollback.ok) {
      return rollback;
    }

    this.verification.stateStore.clear(sessionId);
    this.recordEvent({
      sessionId,
      type: "verification_state_reset",
      turn,
      payload: {
        reason: "rollback",
      },
    });
    this.ledger.append({
      sessionId,
      turn,
      skill: this.getActiveSkill(sessionId)?.name,
      tool: "brewva_rollback",
      argsSummary: `patchSet=${rollback.patchSetId ?? "unknown"}`,
      outputSummary: `restored=${rollback.restoredPaths.length} failed=${rollback.failedPaths.length}`,
      fullOutput: JSON.stringify(rollback),
      verdict: rollback.failedPaths.length === 0 ? "pass" : "fail",
      metadata: {
        source: "rollback_tool",
        patchSetId: rollback.patchSetId ?? null,
        restoredPaths: rollback.restoredPaths,
        failedPaths: rollback.failedPaths,
      },
    });
    return rollback;
  }

  resolveUndoSessionId(preferredSessionId?: string): string | undefined {
    if (preferredSessionId && this.fileChanges.hasHistory(preferredSessionId)) {
      return preferredSessionId;
    }
    return this.fileChanges.latestSessionWithHistory();
  }

  recordToolResult(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    success: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }): string {
    const turn = this.getCurrentTurn(input.sessionId);
    const activeSkill = this.getActiveSkill(input.sessionId);
    const verdict = input.verdict ?? (input.success ? "pass" : "fail");

    const ledgerRow = this.ledger.append({
      sessionId: input.sessionId,
      turn,
      skill: activeSkill?.name,
      tool: input.toolName,
      argsSummary: JSON.stringify(input.args).slice(0, 400),
      outputSummary: input.outputText.slice(0, 500),
      fullOutput: input.outputText,
      verdict,
      metadata: input.metadata,
    });

    syncTruthFromToolResult(this, {
      sessionId: input.sessionId,
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      success: input.success,
      ledgerRow: {
        id: ledgerRow.id,
        outputHash: ledgerRow.outputHash,
        argsSummary: ledgerRow.argsSummary,
        outputSummary: ledgerRow.outputSummary,
      },
      metadata: input.metadata,
    });

    const evidence = classifyEvidence({
      now: Date.now(),
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      success: input.success,
    });

    this.verification.stateStore.appendEvidence(input.sessionId, evidence);
    this.recordEvent({
      sessionId: input.sessionId,
      type: "tool_result_recorded",
      turn,
      payload: {
        toolName: input.toolName,
        verdict,
        success: input.success,
        ledgerId: ledgerRow.id,
      },
    });
    this.maybeCompactLedger(input.sessionId, turn);
    return ledgerRow.id;
  }

  getLedgerDigest(sessionId: string): string {
    const rows = this.ledger.list(sessionId);
    const digest = buildLedgerDigest(
      sessionId,
      rows,
      this.config.ledger.digestWindow,
      this.config.skills.selector.maxDigestTokens,
    );

    const lines: string[] = [
      `[EvidenceDigest session=${sessionId}]`,
      `count=${digest.summary.total} pass=${digest.summary.pass} fail=${digest.summary.fail} inconclusive=${digest.summary.inconclusive}`,
    ];
    for (const row of digest.records) {
      lines.push(`- ${row.tool}(${row.verdict}) ${row.argsSummary}`);
    }
    return lines.join("\n");
  }

  queryLedger(sessionId: string, query: EvidenceQuery): string {
    const rows = this.ledger.query(sessionId, query);
    return formatLedgerRows(rows);
  }

  setTaskSpec(sessionId: string, spec: TaskSpec): void {
    const normalized = normalizeTaskSpec(spec);
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "spec_set",
        spec: normalized,
      },
    });
  }

  addTaskItem(
    sessionId: string,
    input: { id?: string; text: string; status?: TaskItemStatus },
  ): { ok: boolean; itemId?: string; error?: string } {
    const text = input.text?.trim();
    if (!text) {
      return { ok: false, error: "missing_text" };
    }

    const payload = buildItemAddedEvent({
      id: input.id?.trim() || undefined,
      text,
      status: input.status,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true, itemId: payload.item.id };
  }

  updateTaskItem(
    sessionId: string,
    input: { id: string; text?: string; status?: TaskItemStatus },
  ): { ok: boolean; error?: string } {
    const id = input.id?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const text = input.text?.trim();
    if (!text && !input.status) {
      return { ok: false, error: "missing_patch" };
    }

    const payload = buildItemUpdatedEvent({
      id,
      text: text || undefined,
      status: input.status,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true };
  }

  recordTaskBlocker(
    sessionId: string,
    input: {
      id?: string;
      message: string;
      source?: string;
      truthFactId?: string;
    },
  ): { ok: boolean; blockerId?: string; error?: string } {
    const message = input.message?.trim();
    if (!message) {
      return { ok: false, error: "missing_message" };
    }

    const payload = buildBlockerRecordedEvent({
      id: input.id?.trim() || undefined,
      message,
      source: input.source?.trim() || undefined,
      truthFactId: input.truthFactId?.trim() || undefined,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true, blockerId: payload.blocker.id };
  }

  resolveTaskBlocker(sessionId: string, blockerId: string): { ok: boolean; error?: string } {
    const id = blockerId?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const payload = buildBlockerResolvedEvent(id);
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    return { ok: true };
  }

  private resolveTapePressureLevel(entriesSinceAnchor: number): TapePressureLevel {
    const thresholds = this.config.tape.tapePressureThresholds;
    if (entriesSinceAnchor >= thresholds.high) return "high";
    if (entriesSinceAnchor >= thresholds.medium) return "medium";
    if (entriesSinceAnchor >= thresholds.low) return "low";
    return "none";
  }

  getTapeStatus(sessionId: string): TapeStatusState {
    const events = this.queryEvents(sessionId);
    const totalEntries = events.length;

    let lastAnchorIndex = -1;
    let lastCheckpointIndex = -1;
    let lastAnchorEvent: BrewvaEventRecord | undefined;
    let lastCheckpointId: string | undefined;

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;

      if (lastCheckpointIndex < 0 && event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
        lastCheckpointIndex = index;
        lastCheckpointId = event.id;
      }

      if (lastAnchorIndex < 0 && event.type === TAPE_ANCHOR_EVENT_TYPE) {
        lastAnchorIndex = index;
        lastAnchorEvent = event;
      }

      if (lastAnchorIndex >= 0 && lastCheckpointIndex >= 0) {
        break;
      }
    }

    const entriesSinceAnchor =
      lastAnchorIndex >= 0 ? Math.max(0, totalEntries - lastAnchorIndex - 1) : totalEntries;
    const entriesSinceCheckpoint =
      lastCheckpointIndex >= 0 ? Math.max(0, totalEntries - lastCheckpointIndex - 1) : totalEntries;

    const thresholds = this.config.tape.tapePressureThresholds;
    const anchorPayload = coerceTapeAnchorPayload(lastAnchorEvent?.payload);

    return {
      totalEntries,
      entriesSinceAnchor,
      entriesSinceCheckpoint,
      tapePressure: this.resolveTapePressureLevel(entriesSinceAnchor),
      thresholds: {
        low: thresholds.low,
        medium: thresholds.medium,
        high: thresholds.high,
      },
      lastAnchor: lastAnchorEvent
        ? {
            id: lastAnchorEvent.id,
            name: anchorPayload?.name,
            summary: anchorPayload?.summary,
            nextSteps: anchorPayload?.nextSteps,
            turn: lastAnchorEvent.turn,
            timestamp: lastAnchorEvent.timestamp,
          }
        : undefined,
      lastCheckpointId,
    };
  }

  recordTapeHandoff(
    sessionId: string,
    input: { name: string; summary?: string; nextSteps?: string },
  ): {
    ok: boolean;
    eventId?: string;
    createdAt?: number;
    error?: string;
    tapeStatus?: TapeStatusState;
  } {
    const name = input.name?.trim();
    if (!name) {
      return { ok: false, error: "missing_name" };
    }

    const summary = input.summary?.trim() || undefined;
    const nextSteps = input.nextSteps?.trim() || undefined;
    const payload = buildTapeAnchorPayload({
      name,
      summary,
      nextSteps,
    });

    const row = this.recordEvent({
      sessionId,
      type: TAPE_ANCHOR_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: payload as unknown as Record<string, unknown>,
    });
    if (!row) {
      return { ok: false, error: "event_store_disabled" };
    }

    return {
      ok: true,
      eventId: row.id,
      createdAt: payload.createdAt,
      tapeStatus: this.getTapeStatus(sessionId),
    };
  }

  private buildTapeSearchText(event: BrewvaEventRecord): string {
    if (event.type === TAPE_ANCHOR_EVENT_TYPE) {
      const payload = coerceTapeAnchorPayload(event.payload);
      if (!payload) return `anchor ${event.id}`;
      return ["anchor", payload.name, payload.summary ?? "", payload.nextSteps ?? ""]
        .join(" ")
        .trim();
    }
    const payloadText =
      event.payload && Object.keys(event.payload).length > 0 ? JSON.stringify(event.payload) : "";
    return `${event.type} ${payloadText}`.trim();
  }

  private trimSearchExcerpt(text: string, maxChars = 220): string {
    const compact = text.replaceAll(/\s+/g, " ").trim();
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
  }

  private scopeTapeEvents(
    events: BrewvaEventRecord[],
    scope: TapeSearchScope,
  ): BrewvaEventRecord[] {
    if (scope === "anchors_only") {
      return events.filter((event) => event.type === TAPE_ANCHOR_EVENT_TYPE);
    }
    if (scope === "all_phases") {
      return events;
    }

    let lastAnchorIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type !== TAPE_ANCHOR_EVENT_TYPE) continue;
      lastAnchorIndex = index;
      break;
    }
    if (lastAnchorIndex < 0) return events;
    return events.slice(lastAnchorIndex);
  }

  searchTape(
    sessionId: string,
    input: { query: string; scope?: TapeSearchScope; limit?: number },
  ): TapeSearchResult {
    const query = input.query.trim();
    const scope: TapeSearchScope = input.scope ?? "current_phase";
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 12)));
    const events = this.queryEvents(sessionId);
    const scopedEvents = this.scopeTapeEvents(events, scope);

    if (!query) {
      return {
        query,
        scope,
        scannedEvents: scopedEvents.length,
        totalEvents: events.length,
        matches: [],
      };
    }

    const needle = query.toLowerCase();
    const matches: TapeSearchMatch[] = [];

    for (let index = scopedEvents.length - 1; index >= 0; index -= 1) {
      if (matches.length >= limit) break;
      const event = scopedEvents[index];
      if (!event) continue;

      const haystack = this.buildTapeSearchText(event);
      if (!haystack.toLowerCase().includes(needle)) continue;

      matches.push({
        eventId: event.id,
        type: event.type,
        turn: event.turn,
        timestamp: event.timestamp,
        excerpt: this.trimSearchExcerpt(haystack),
      });
    }

    return {
      query,
      scope,
      scannedEvents: scopedEvents.length,
      totalEvents: events.length,
      matches,
    };
  }

  getTaskState(sessionId: string): TaskState {
    return this.turnReplay.getTaskState(sessionId);
  }

  getTruthState(sessionId: string): TruthState {
    return this.turnReplay.getTruthState(sessionId);
  }

  upsertTruthFact(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: TruthFactStatus;
    },
  ): { ok: boolean; fact?: TruthFact; error?: string } {
    const id = input.id?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const kind = input.kind?.trim();
    if (!kind) return { ok: false, error: "missing_kind" };

    const summary = input.summary?.trim();
    if (!summary) return { ok: false, error: "missing_summary" };

    const now = Date.now();
    const state = this.getTruthState(sessionId);
    const existing = state.facts.find((fact) => fact.id === id);
    const status: TruthFactStatus = input.status ?? "active";
    const evidenceIds = [
      ...new Set([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])]),
    ];

    const fact: TruthFact = {
      id,
      kind,
      status,
      severity: input.severity,
      summary,
      details: normalizeJsonRecord(input.details),
      evidenceIds,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      resolvedAt: status === "resolved" ? (existing?.resolvedAt ?? now) : undefined,
    };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactUpsertedEvent(fact) as unknown as Record<string, unknown>,
    });
    return { ok: true, fact };
  }

  resolveTruthFact(sessionId: string, truthFactId: string): { ok: boolean; error?: string } {
    const id = truthFactId?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactResolvedEvent({
        factId: id,
        resolvedAt: Date.now(),
      }) as unknown as Record<string, unknown>,
    });
    return { ok: true };
  }

  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): BrewvaEventRecord | undefined {
    const row = this.events.append({
      sessionId: input.sessionId,
      type: input.type,
      turn: input.turn,
      payload: input.payload,
      timestamp: input.timestamp,
    });
    if (!row) return undefined;
    this.turnReplay.invalidate(row.sessionId);

    const structured = this.toStructuredEvent(row);
    for (const listener of this.eventListeners.values()) {
      listener(structured);
    }
    if (!input.skipTapeCheckpoint) {
      this.maybeRecordTapeCheckpoint(row);
    }
    return row;
  }

  queryEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaEventRecord[] {
    return this.events.list(sessionId, query);
  }

  queryStructuredEvents(sessionId: string, query: BrewvaEventQuery = {}): BrewvaStructuredEvent[] {
    return this.events.list(sessionId, query).map((event) => this.toStructuredEvent(event));
  }

  listReplaySessions(limit = 20): BrewvaReplaySession[] {
    const sessionIds = this.events.listSessionIds();
    const rows: BrewvaReplaySession[] = [];

    for (const sessionId of sessionIds) {
      const events = this.events.list(sessionId);
      if (events.length === 0) continue;
      const lastEventAt = events[events.length - 1]?.timestamp ?? 0;
      rows.push({
        sessionId,
        eventCount: events.length,
        lastEventAt,
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  toStructuredEvent(event: BrewvaEventRecord): BrewvaStructuredEvent {
    return {
      schema: "brewva.event.v1",
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      category: inferEventCategory(event.type),
      timestamp: event.timestamp,
      isoTime: new Date(event.timestamp).toISOString(),
      turn: event.turn,
      payload: event.payload,
    };
  }

  recordAssistantUsage(input: {
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    stopReason?: string;
  }): SessionCostSummary {
    const turn = this.getCurrentTurn(input.sessionId);
    const skillName = this.getActiveSkill(input.sessionId)?.name;
    const usageResult = this.costTracker.recordUsage(
      input.sessionId,
      {
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens,
        costUsd: input.costUsd,
      },
      {
        turn,
        skill: skillName,
      },
    );
    const summary = usageResult.summary;

    this.recordEvent({
      sessionId: input.sessionId,
      type: "cost_update",
      turn,
      payload: {
        model: input.model,
        skill: skillName ?? null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        totalTokens: input.totalTokens,
        costUsd: input.costUsd,
        sessionCostUsd: summary.totalCostUsd,
        sessionTokens: summary.totalTokens,
        budget: summary.budget,
        stopReason: input.stopReason ?? null,
      },
    });

    for (const alert of usageResult.newAlerts) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "budget_alert",
        turn,
        payload: {
          kind: alert.kind,
          scope: alert.scope,
          scopeId: alert.scopeId ?? null,
          costUsd: alert.costUsd,
          thresholdUsd: alert.thresholdUsd,
          action: summary.budget.action,
        },
      });
    }

    this.ledger.append({
      sessionId: input.sessionId,
      turn,
      skill: skillName,
      tool: "brewva_cost",
      argsSummary: `model=${input.model}`,
      outputSummary: `tokens=${input.totalTokens} cost=${input.costUsd.toFixed(6)} usd`,
      fullOutput: JSON.stringify({
        model: input.model,
        usage: {
          input: input.inputTokens,
          output: input.outputTokens,
          cacheRead: input.cacheReadTokens,
          cacheWrite: input.cacheWriteTokens,
          total: input.totalTokens,
        },
        allocation: {
          skill: skillName ?? "(none)",
          turn,
          tools: summary.tools,
        },
        costUsd: input.costUsd,
        sessionCostUsd: summary.totalCostUsd,
      }),
      verdict: "inconclusive",
      metadata: {
        source: "llm_usage",
        model: input.model,
        usage: {
          input: input.inputTokens,
          output: input.outputTokens,
          cacheRead: input.cacheReadTokens,
          cacheWrite: input.cacheWriteTokens,
          total: input.totalTokens,
        },
        skill: skillName ?? null,
        turn,
        costUsd: input.costUsd,
        sessionCostUsd: summary.totalCostUsd,
      },
    });

    return summary;
  }
  getCostSummary(sessionId: string): SessionCostSummary {
    return this.costTracker.getSummary(sessionId);
  }

  evaluateCompletion(sessionId: string, level?: VerificationLevel): VerificationReport {
    return this.verification.evaluate(sessionId, level);
  }

  recordWorkerResult(sessionId: string, result: WorkerResult): void {
    this.parallelResults.record(sessionId, result);
    this.parallel.release(sessionId, result.workerId);
  }

  listWorkerResults(sessionId: string): WorkerResult[] {
    return this.parallelResults.list(sessionId);
  }

  mergeWorkerResults(sessionId: string): WorkerMergeReport {
    return this.parallelResults.merge(sessionId);
  }

  clearWorkerResults(sessionId: string): void {
    this.parallelResults.clear(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.tapeCheckpointWriteInProgressBySession.delete(sessionId);
    this.activeSkillsBySession.delete(sessionId);
    this.turnsBySession.delete(sessionId);
    this.toolCallsBySession.delete(sessionId);
    this.lastLedgerCompactionTurnBySession.delete(sessionId);
    this.toolContractWarningsBySession.delete(sessionId);
    this.skillBudgetWarningsBySession.delete(sessionId);
    this.skillParallelWarningsBySession.delete(sessionId);
    this.skillOutputsBySession.delete(sessionId);

    this.fileChanges.clearSession(sessionId);
    this.verification.stateStore.clear(sessionId);
    this.parallel.clear(sessionId);
    this.parallelResults.clear(sessionId);
    this.contextBudget.clear(sessionId);
    this.costTracker.clear(sessionId);

    this.contextInjection.clearSession(sessionId);
    this.latestCompactionSummaryBySession.delete(sessionId);
    this.clearInjectionFingerprintsForSession(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);

    this.turnReplay.clear(sessionId);
    this.viewportPolicyBySession.delete(sessionId);

    this.events.clearSessionCache(sessionId);
    this.ledger.clearSessionCache(sessionId);
  }

  async verifyCompletion(
    sessionId: string,
    level?: VerificationLevel,
    options: VerifyCompletionOptions = {},
  ): Promise<VerificationReport> {
    const effectiveLevel = level ?? this.config.verification.defaultLevel;
    const executeCommands = options.executeCommands !== false;

    if (executeCommands && effectiveLevel !== "quick") {
      await this.runVerificationCommands(sessionId, effectiveLevel, {
        timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
      });
    }

    const report = this.verification.evaluate(sessionId, effectiveLevel, {
      requireCommands: executeCommands,
    });
    this.syncVerificationBlockers(sessionId, report);
    return report;
  }

  private syncVerificationBlockers(sessionId: string, report: VerificationReport): void {
    const verificationState = this.verification.stateStore.get(sessionId);
    if (!verificationState.lastWriteAt) return;

    const lastWriteAt = verificationState.lastWriteAt ?? 0;
    const current = this.getTaskState(sessionId);
    const existingById = new Map(current.blockers.map((blocker) => [blocker.id, blocker]));
    const failingIds = new Set<string>();
    const truthFactIdForCheck = (checkName: string): string =>
      `truth:verifier:${normalizeVerifierCheckForId(checkName)}`;

    for (const check of report.checks) {
      if (check.status !== "fail") continue;

      const blockerId = `${VERIFIER_BLOCKER_PREFIX}${normalizeVerifierCheckForId(check.name)}`;
      const truthFactId = truthFactIdForCheck(check.name);
      failingIds.add(blockerId);

      const run = verificationState.checkRuns[check.name];
      const freshRun = run && run.timestamp >= lastWriteAt ? run : undefined;
      const message = buildVerifierBlockerMessage({
        checkName: check.name,
        truthFactId,
        run: freshRun,
      });
      const source = "verification_gate";

      const existing = existingById.get(blockerId);
      if (
        existing &&
        existing.message === message &&
        (existing.source ?? "") === source &&
        (existing.truthFactId ?? "") === truthFactId
      ) {
        continue;
      }

      const evidenceIds = freshRun?.ledgerId ? [freshRun.ledgerId] : [];
      this.upsertTruthFact(sessionId, {
        id: truthFactId,
        kind: "verification_check_failed",
        severity: "error",
        summary: `verification failed: ${check.name}`,
        evidenceIds,
        details: {
          check: check.name,
          command: freshRun?.command ?? null,
          exitCode: freshRun?.exitCode ?? null,
          ledgerId: freshRun?.ledgerId ?? null,
          evidence: check.evidence ?? null,
        },
      });
      this.recordTaskBlocker(sessionId, {
        id: blockerId,
        message,
        source,
        truthFactId,
      });
    }

    const truthState = this.getTruthState(sessionId);
    for (const blocker of current.blockers) {
      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) continue;
      if (failingIds.has(blocker.id)) continue;
      this.resolveTaskBlocker(sessionId, blocker.id);
      const truthFactId =
        blocker.truthFactId ?? `truth:verifier:${blocker.id.slice(VERIFIER_BLOCKER_PREFIX.length)}`;
      const active = truthState.facts.find(
        (fact) => fact.id === truthFactId && fact.status === "active",
      );
      if (active) {
        this.resolveTruthFact(sessionId, truthFactId);
      }
    }
  }

  sanitizeInput(text: string): string {
    if (!this.config.security.sanitizeContext) {
      return text;
    }
    return sanitizeContextText(text);
  }

  private getCurrentTurn(sessionId: string): number {
    return this.turnsBySession.get(sessionId) ?? 0;
  }

  private async runVerificationCommands(
    sessionId: string,
    level: VerificationLevel,
    options: { timeoutMs: number },
  ): Promise<void> {
    const state = this.verification.stateStore.get(sessionId);
    if (!state.lastWriteAt) return;

    const checks = this.config.verification.checks[level] ?? [];
    for (const checkName of checks) {
      const command = this.config.verification.commands[checkName];
      if (!command) continue;
      if (checkName === "diff-review") continue;

      const existing = state.checkRuns[checkName];
      const isFresh = existing && existing.ok && existing.timestamp >= state.lastWriteAt;
      if (isFresh) continue;

      const result = await runShellCommand(command, {
        cwd: this.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputChars: 200_000,
      });

      const ok = result.exitCode === 0 && !result.timedOut;
      const outputText = `${result.stdout}\n${result.stderr}`.trim();
      const outputSummary =
        outputText.length > 0 ? outputText.slice(0, 2000) : ok ? "(no output)" : "(no output)";

      const timestamp = Date.now();
      const ledgerId = this.recordToolResult({
        sessionId,
        toolName: "brewva_verify",
        args: { check: checkName, command },
        outputText: outputSummary,
        success: ok,
        verdict: ok ? "pass" : "fail",
        metadata: {
          source: "verification_gate",
          check: checkName,
          command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        },
      });

      this.verification.stateStore.setCheckRun(sessionId, checkName, {
        timestamp,
        ok,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ledgerId,
        outputSummary,
      });
    }
  }

  private maybeCompactLedger(sessionId: string, turn: number): void {
    const every = Math.max(0, Math.trunc(this.config.ledger.checkpointEveryTurns));
    if (every <= 0) return;
    if (turn <= 0) return;
    if (turn % every !== 0) return;
    if (this.lastLedgerCompactionTurnBySession.get(sessionId) === turn) {
      return;
    }

    const keepLast = Math.max(2, Math.min(this.config.ledger.digestWindow, every - 1));
    const result = this.ledger.compactSession(sessionId, {
      keepLast,
      reason: `turn-${turn}`,
    });
    if (!result) return;
    this.lastLedgerCompactionTurnBySession.set(sessionId, turn);
    this.recordEvent({
      sessionId,
      type: "ledger_compacted",
      turn,
      payload: {
        compacted: result.compacted,
        kept: result.kept,
        checkpointId: result.checkpointId,
      },
    });
  }

  private resolveTapeCheckpointIntervalEntries(): number {
    const configured = this.config.tape.checkpointIntervalEntries;
    if (!Number.isFinite(configured)) return 0;
    return Math.max(0, Math.floor(configured));
  }

  private maybeRecordTapeCheckpoint(lastEvent: BrewvaEventRecord): void {
    if (lastEvent.type === TAPE_CHECKPOINT_EVENT_TYPE) {
      return;
    }

    const intervalEntries = this.resolveTapeCheckpointIntervalEntries();
    if (intervalEntries <= 0) {
      return;
    }

    const sessionId = lastEvent.sessionId;
    if (this.tapeCheckpointWriteInProgressBySession.has(sessionId)) {
      return;
    }

    const events = this.queryEvents(sessionId);
    if (events.length === 0) {
      return;
    }

    let latestAnchorEventId: string | undefined;
    let entriesSinceCheckpoint = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (!latestAnchorEventId && event.type === TAPE_ANCHOR_EVENT_TYPE) {
        latestAnchorEventId = event.id;
      }
      if (event.type === TAPE_CHECKPOINT_EVENT_TYPE) {
        break;
      }
      entriesSinceCheckpoint += 1;
    }

    if (entriesSinceCheckpoint < intervalEntries) {
      return;
    }

    this.tapeCheckpointWriteInProgressBySession.add(sessionId);
    try {
      const payload = buildTapeCheckpointPayload({
        taskState: this.turnReplay.getTaskState(sessionId),
        truthState: this.turnReplay.getTruthState(sessionId),
        basedOnEventId: lastEvent.id,
        latestAnchorEventId,
        reason: `interval_entries_${intervalEntries}`,
      });
      this.recordEvent({
        sessionId,
        turn: this.getCurrentTurn(sessionId),
        type: TAPE_CHECKPOINT_EVENT_TYPE,
        payload: payload as unknown as Record<string, unknown>,
        skipTapeCheckpoint: true,
      });
    } finally {
      this.tapeCheckpointWriteInProgressBySession.delete(sessionId);
    }
  }

  private isContextBudgetEnabled(): boolean {
    return this.config.infrastructure.contextBudget.enabled;
  }

  private buildInjectionScopeKey(sessionId: string, scopeId?: string): string {
    const normalizedScope = scopeId?.trim();
    if (!normalizedScope) return `${sessionId}::root`;
    return `${sessionId}::${normalizedScope}`;
  }

  private clearInjectionFingerprintsForSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of this.lastInjectedContextFingerprintBySession.keys()) {
      if (key.startsWith(prefix)) {
        this.lastInjectedContextFingerprintBySession.delete(key);
      }
    }
  }

  private clearReservedInjectionTokensForSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of this.reservedContextInjectionTokensByScope.keys()) {
      if (key.startsWith(prefix)) {
        this.reservedContextInjectionTokensByScope.delete(key);
      }
    }
  }
}
