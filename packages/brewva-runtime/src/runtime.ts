import { relative, resolve } from "node:path";
import type {
  ContextPressureLevel,
  ContextPressureStatus,
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
import type {
  TruthFact,
  TruthFactSeverity,
  TruthFactStatus,
  TruthState,
} from "./types.js";
import { loadBrewvaConfig } from "./config/loader.js";
import { SkillRegistry } from "./skills/registry.js";
import { selectTopKSkills } from "./skills/selector.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { buildLedgerDigest } from "./ledger/digest.js";
import { formatLedgerRows } from "./ledger/query.js";
import {
  extractEvidenceArtifacts,
  type EvidenceArtifact,
} from "./evidence/artifacts.js";
import { parseTscDiagnostics } from "./evidence/tsc.js";
import { classifyEvidence, isMutationTool } from "./verification/classifier.js";
import { VerificationGate } from "./verification/gate.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { normalizePercent } from "./utils/token.js";
import { redactSecrets } from "./security/redact.js";
import { checkToolAccess } from "./security/tool-policy.js";
import { runShellCommand } from "./utils/exec.js";
import { ContextBudgetManager } from "./context/budget.js";
import {
  ContextInjectionCollector,
  type ContextInjectionPriority,
} from "./context/injection.js";
import {
  buildViewportContext,
  type ViewportContextResult,
  type ViewportMetrics,
} from "./context/viewport.js";
import { buildTruthLedgerBlock } from "./context/truth.js";
import { buildTruthFactsBlock } from "./context/truth-facts.js";
import {
  classifyViewportQuality,
  computeViewportSignalScore,
  shouldSkipViewportInjection,
  type ViewportQuality,
} from "./policy/viewport-policy.js";
import { BrewvaEventStore } from "./events/store.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { SessionCostTracker } from "./cost/tracker.js";
import { sha256 } from "./utils/hash.js";
import { normalizeJsonRecord } from "./utils/json.js";
import {
  estimateTokenCount,
  truncateTextToTokenBudget,
} from "./utils/token.js";
import {
  TASK_EVENT_TYPE,
  buildBlockerRecordedEvent,
  buildBlockerResolvedEvent,
  buildStatusSetEvent,
  buildItemAddedEvent,
  buildItemUpdatedEvent,
  formatTaskStateBlock,
} from "./task/ledger.js";
import {
  TRUTH_EVENT_TYPE,
  buildTruthFactResolvedEvent,
  buildTruthFactUpsertedEvent,
} from "./truth/ledger.js";
import { normalizeTaskSpec } from "./task/spec.js";
import { TurnReplayEngine } from "./tape/replay-engine.js";
import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
  coerceTapeAnchorPayload,
} from "./tape/events.js";

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
const OUTPUT_HEALTH_GUARD_SCORE_THRESHOLD = 0.4;

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

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
  const parts: string[] = [
    `verification failed: ${input.checkName}`,
    `truth=${input.truthFactId}`,
  ];
  if (input.run?.ledgerId) {
    parts.push(`evidence=${input.run.ledgerId}`);
  }
  if (
    input.run &&
    input.run.exitCode !== null &&
    input.run.exitCode !== undefined
  ) {
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
  if (
    type.startsWith("session_") ||
    type === "session_start" ||
    type === "session_shutdown"
  )
    return "session";
  if (type.startsWith("turn_")) return "turn";
  if (type.includes("tool") || type.startsWith("patch_") || type === "rollback")
    return "tool";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("cost_") || type.startsWith("budget_")) return "cost";
  if (type.startsWith("verification_")) return "verification";
  if (
    type.includes("snapshot") ||
    type.includes("resumed") ||
    type.includes("interrupted")
  )
    return "state";
  return "other";
}

function buildSkillCandidateBlock(selected: SkillSelection[]): string {
  const skillLines =
    selected.length > 0
      ? selected.map(
          (entry) =>
            `- ${entry.name} (score=${entry.score}, reason=${entry.reason})`,
        )
      : ["- (none)"];
  return ["[Brewva Context]", "Top-K Skill Candidates:", ...skillLines].join(
    "\n",
  );
}

function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}

function buildContextSourceTokenLimits(
  maxInjectionTokens: number,
): Record<string, number> {
  const budget = Math.max(64, Math.floor(maxInjectionTokens));
  const fromRatio = (
    ratio: number,
    minimum: number,
    maximum = budget,
  ): number => {
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
  readonly config: BrewvaConfig;
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
  private skillOutputsBySession = new Map<
    string,
    Map<string, SkillOutputRecord>
  >();
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
    this.config =
      options.config ??
      loadBrewvaConfig({ cwd: this.cwd, configPath: options.configPath });

    this.skills = new SkillRegistry({
      rootDir: this.cwd,
      config: this.config,
    });
    this.skills.load();
    this.skills.writeIndex();

    const ledgerPath = resolve(this.cwd, this.config.ledger.path);
    this.ledger = new EvidenceLedger(ledgerPath);
    this.verification = new VerificationGate(this.config);
    this.parallel = new ParallelBudgetManager(this.config.parallel);
    this.parallelResults = new ParallelResultStore();
    this.events = new BrewvaEventStore(
      this.config.infrastructure.events,
      this.cwd,
    );
    this.contextBudget = new ContextBudgetManager(
      this.config.infrastructure.contextBudget,
    );
    this.contextInjection = new ContextInjectionCollector({
      sourceTokenLimits: this.isContextBudgetEnabled()
        ? buildContextSourceTokenLimits(
            this.config.infrastructure.contextBudget.maxInjectionTokens,
          )
        : {},
      truncationStrategy:
        this.config.infrastructure.contextBudget.truncationStrategy,
    });
    this.turnReplay = new TurnReplayEngine({
      listEvents: (sessionId) => this.queryEvents(sessionId),
      getTurn: (sessionId) => this.getCurrentTurn(sessionId),
    });
    this.fileChanges = new FileChangeTracker(this.cwd);
    this.costTracker = new SessionCostTracker(
      this.config.infrastructure.costTracking,
    );
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
    const input = this.config.security.sanitizeContext
      ? sanitizeContextText(message)
      : message;
    return selectTopKSkills(
      input,
      this.skills.buildIndex(),
      this.config.skills.selector.k,
    );
  }

  onTurnStart(sessionId: string, turnIndex: number): void {
    const current = this.turnsBySession.get(sessionId) ?? 0;
    const effectiveTurn = Math.max(current, turnIndex);
    this.turnsBySession.set(sessionId, effectiveTurn);
    this.contextBudget.beginTurn(sessionId, effectiveTurn);
    this.contextInjection.clearPending(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
  }

  observeContextUsage(
    sessionId: string,
    usage: ContextBudgetUsage | undefined,
  ): void {
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
    const ratio = this.normalizeRatio(
      this.config.infrastructure.contextBudget.hardLimitPercent,
    );
    if (ratio === null) return 1;
    return Math.max(0, Math.min(1, ratio));
  }

  getContextCompactionThresholdRatio(): number {
    const thresholdRatio = this.normalizeRatio(
      this.config.infrastructure.contextBudget.compactionThresholdPercent,
    );
    return thresholdRatio ?? this.getContextHardLimitRatio();
  }

  getContextPressureStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextPressureStatus {
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

  getContextPressureLevel(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextPressureLevel {
    return this.getContextPressureStatus(sessionId, usage).level;
  }

  private isSameTaskStatus(
    left: TaskStatus | undefined,
    right: TaskStatus,
  ): boolean {
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

    const activeTruthFacts = input.truthState.facts.filter(
      (fact) => fact.status === "active",
    );
    const severityRank = (severity: string): number => {
      if (severity === "error") return 3;
      if (severity === "warn") return 2;
      return 1;
    };
    const truthFactIds = activeTruthFacts
      .slice()
      .sort((left, right) => {
        const severity =
          severityRank(right.severity) - severityRank(left.severity);
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
      reason = hasVerifier
        ? "verification_blockers_present"
        : "blockers_present";
    } else if (items.length === 0) {
      phase = "investigate";
      health = "ok";
      reason = "no_task_items";
    } else if (openItems.length > 0) {
      phase = "execute";
      health = "ok";
      reason = `open_items=${openItems.length}`;
    } else {
      const desiredLevel =
        state.spec?.verification?.level ??
        this.config.verification.defaultLevel;
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
          normalizePercent(
            this.config.infrastructure.contextBudget.compactionThresholdPercent,
          ) ?? 1;
        const hardLimit =
          normalizePercent(
            this.config.infrastructure.contextBudget.hardLimitPercent,
          ) ?? 1;
        if (ratio >= hardLimit || ratio >= threshold) {
          health = "budget_pressure";
          reason =
            ratio >= hardLimit
              ? "context_hard_limit_pressure"
              : "context_usage_pressure";
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
            .filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
            .slice(0, 8)
        : [];
      return { score, drunk, flags };
    }
    return null;
  }

  private buildOutputHealthGuardBlock(health: {
    score: number;
    flags: string[];
  }): string {
    const score = Math.max(0, Math.min(1, health.score));
    const flags = health.flags.length > 0 ? health.flags.join(",") : "none";
    return [
      "[OutputHealthGuard]",
      `score=${score.toFixed(2)} flags=${flags}`,
      "- Keep sentences short and concrete.",
      "- Do not repeat the same reasoning. If stuck, stop and verify or ask for missing info.",
      "- Prefer tool-based verification over speculation.",
    ].join("\n");
  }

  private buildViewportPolicyGuardBlock(input: {
    quality: ViewportQuality;
    variant: string;
    score: number | null;
    snr: number | null;
    effectiveSnr: number | null;
    reason: string;
    metrics: ViewportMetrics;
  }): string {
    const format = (value: number | null): string =>
      value === null ? "null" : value.toFixed(2);
    const included =
      input.metrics.includedFiles.length > 0
        ? input.metrics.includedFiles.join(", ")
        : "(none)";
    const unavailable =
      input.metrics.unavailableFiles.length > 0
        ? input.metrics.unavailableFiles
            .slice(0, 3)
            .map((entry) => `${entry.file}:${entry.reason}`)
            .join(", ")
        : "none";

    return [
      "[ViewportPolicy]",
      `quality=${input.quality} variant=${input.variant} reason=${input.reason}`,
      `score=${format(input.score)} snr=${format(input.snr)} effectiveSnr=${format(input.effectiveSnr)}`,
      `includedFiles=${included}`,
      `unavailableFiles=${unavailable}`,
      "",
      "Policy:",
      "- Treat low-signal viewport as unreliable; do not start editing yet.",
      "- Refine TaskSpec targets.files/targets.symbols, or gather evidence (lsp_symbols, lsp_diagnostics).",
      "- Re-run diagnostics/verification before applying patches.",
    ].join("\n");
  }

  private decideViewportPolicy(input: {
    sessionId: string;
    goal: string;
    targetFiles: string[];
    targetSymbols: string[];
  }): {
    selected: ViewportContextResult;
    injected: boolean;
    variant: "full" | "no_neighborhood" | "minimal" | "skipped";
    quality: ViewportQuality;
    score: number | null;
    snr: number | null;
    effectiveSnr: number | null;
    reason: string;
    guardBlock?: string;
    evaluated: Array<{
      variant: string;
      metrics: ViewportMetrics;
      score: number | null;
      snr: number | null;
      effectiveSnr: number | null;
    }>;
  } {
    const build = (
      options: Partial<Parameters<typeof buildViewportContext>[0]>,
    ): ViewportContextResult => {
      return buildViewportContext({
        cwd: this.cwd,
        goal: input.goal,
        targetFiles: input.targetFiles,
        targetSymbols: input.targetSymbols,
        ...options,
      });
    };

    const evaluated: Array<{
      variant: string;
      result: ViewportContextResult;
      metrics: ViewportMetrics;
      score: ReturnType<typeof computeViewportSignalScore>;
    }> = [];

    const full = build({});
    const fullScore = computeViewportSignalScore(full.metrics);
    evaluated.push({
      variant: "full",
      result: full,
      metrics: full.metrics,
      score: fullScore,
    });

    const skipDecision = shouldSkipViewportInjection({
      metrics: full.metrics,
      score: fullScore,
    });

    if (skipDecision.skip) {
      const reason = skipDecision.reason ?? "viewport_policy_skip";
      const guardBlock = this.buildViewportPolicyGuardBlock({
        quality: "low",
        variant: "skipped",
        score: fullScore.score,
        snr: fullScore.snr,
        effectiveSnr: fullScore.effectiveSnr,
        reason,
        metrics: full.metrics,
      });
      return {
        selected: full,
        injected: false,
        variant: "skipped",
        quality: "low",
        score: fullScore.score,
        snr: fullScore.snr,
        effectiveSnr: fullScore.effectiveSnr,
        reason,
        guardBlock,
        evaluated: evaluated.map((entry) => ({
          variant: entry.variant,
          metrics: entry.metrics,
          score: entry.score.score,
          snr: entry.score.snr,
          effectiveSnr: entry.score.effectiveSnr,
        })),
      };
    }

    const isBetter = (
      current: {
        result: ViewportContextResult;
        score: ReturnType<typeof computeViewportSignalScore>;
      },
      candidate: {
        result: ViewportContextResult;
        score: ReturnType<typeof computeViewportSignalScore>;
      },
    ): boolean => {
      const currentScore = current.score.score ?? -1;
      const candidateScore = candidate.score.score ?? -1;
      const improvement = candidateScore - currentScore;
      if (improvement > 0.04) return true;

      if (
        current.result.metrics.truncated &&
        !candidate.result.metrics.truncated
      ) {
        if (improvement >= -0.01) return true;
      }

      if (improvement > 0.01) {
        const candidateChars = candidate.result.metrics.totalChars;
        const currentChars = current.result.metrics.totalChars;
        if (candidateChars <= currentChars) return true;
      }

      return false;
    };

    let selectedVariant: "full" | "no_neighborhood" | "minimal" = "full";
    let selectedResult = full;
    let selectedScore = fullScore;
    let selectedQuality = classifyViewportQuality(selectedScore.score);

    const shouldTryNoNeighborhood =
      selectedQuality === "low" ||
      selectedResult.metrics.truncated ||
      ((selectedScore.score ?? 1) < 0.16 &&
        selectedResult.metrics.neighborhoodLines > 12);

    if (shouldTryNoNeighborhood) {
      const noNeighborhood = build({ maxNeighborImports: 0 });
      const score = computeViewportSignalScore(noNeighborhood.metrics);
      evaluated.push({
        variant: "no_neighborhood",
        result: noNeighborhood,
        metrics: noNeighborhood.metrics,
        score,
      });

      if (
        isBetter(
          { result: selectedResult, score: selectedScore },
          { result: noNeighborhood, score },
        )
      ) {
        selectedVariant = "no_neighborhood";
        selectedResult = noNeighborhood;
        selectedScore = score;
        selectedQuality = classifyViewportQuality(selectedScore.score);
      }
    }

    const shouldTryMinimal =
      selectedQuality === "low" || selectedResult.metrics.truncated;
    if (shouldTryMinimal) {
      const minimal = build({
        maxNeighborImports: 0,
        maxImportsPerFile: 0,
      });
      const score = computeViewportSignalScore(minimal.metrics);
      evaluated.push({
        variant: "minimal",
        result: minimal,
        metrics: minimal.metrics,
        score,
      });

      if (
        isBetter(
          { result: selectedResult, score: selectedScore },
          { result: minimal, score },
        )
      ) {
        selectedVariant = "minimal";
        selectedResult = minimal;
        selectedScore = score;
        selectedQuality = classifyViewportQuality(selectedScore.score);
      }
    }

    const reason =
      selectedVariant !== "full"
        ? "viewport_policy_variant_selected"
        : selectedQuality === "low"
          ? "viewport_policy_low_quality"
          : "viewport_policy_ok";

    const guardBlock =
      selectedQuality === "low"
        ? this.buildViewportPolicyGuardBlock({
            quality: selectedQuality,
            variant: selectedVariant,
            score: selectedScore.score,
            snr: selectedScore.snr,
            effectiveSnr: selectedScore.effectiveSnr,
            reason,
            metrics: selectedResult.metrics,
          })
        : undefined;

    return {
      selected: selectedResult,
      injected: Boolean(selectedResult.text),
      variant: selectedVariant,
      quality: selectedQuality,
      score: selectedScore.score,
      snr: selectedScore.snr,
      effectiveSnr: selectedScore.effectiveSnr,
      reason,
      guardBlock,
      evaluated: evaluated.map((entry) => ({
        variant: entry.variant,
        metrics: entry.metrics,
        score: entry.score.score,
        snr: entry.score.snr,
        effectiveSnr: entry.score.effectiveSnr,
      })),
    };
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
    const promptText = this.sanitizeInput(prompt);
    const truthBlock = buildTruthLedgerBlock({ cwd: this.cwd });
    if (truthBlock) {
      this.registerContextInjection(sessionId, {
        source: "brewva.truth",
        id: "truth-ledger",
        priority: "critical",
        oncePerSession: true,
        content: truthBlock,
      });
    }
    const truthState = this.getTruthState(sessionId);
    if (truthState.facts.some((fact) => fact.status === "active")) {
      this.registerContextInjection(sessionId, {
        source: "brewva.truth-facts",
        id: "truth-facts",
        priority: "critical",
        content: buildTruthFactsBlock({ state: truthState }),
      });
    }
    this.maybeAlignTaskStatus({ sessionId, promptText, truthState, usage });

    const outputHealth = this.getLatestOutputHealth(sessionId);
    if (
      outputHealth &&
      (outputHealth.drunk ||
        outputHealth.score < OUTPUT_HEALTH_GUARD_SCORE_THRESHOLD)
    ) {
      this.registerContextInjection(sessionId, {
        source: "brewva.output-guard",
        id: "output-health",
        priority: "high",
        content: this.buildOutputHealthGuardBlock(outputHealth),
      });
    }

    const selected = this.selectSkills(promptText);
    const digest = this.getLedgerDigest(sessionId);
    this.registerContextInjection(sessionId, {
      source: "brewva.skill-candidates",
      id: "top-k-skills",
      priority: "high",
      content: buildSkillCandidateBlock(selected),
    });
    this.registerContextInjection(sessionId, {
      source: "brewva.ledger-digest",
      id: "ledger-digest",
      priority: "normal",
      content: digest,
    });

    const latestCompaction =
      this.latestCompactionSummaryBySession.get(sessionId);
    if (latestCompaction?.summary) {
      this.registerContextInjection(sessionId, {
        source: "brewva.compaction-summary",
        id: latestCompaction.entryId ?? "latest",
        priority: "high",
        oncePerSession: true,
        content: `[CompactionSummary]\n${latestCompaction.summary}`,
      });
    }

    const taskState = this.getTaskState(sessionId);
    if (
      taskState.spec ||
      taskState.status ||
      taskState.items.length > 0 ||
      taskState.blockers.length > 0
    ) {
      const taskBlock = buildTaskStateBlock(taskState);
      if (taskBlock) {
        this.registerContextInjection(sessionId, {
          source: "brewva.task-state",
          id: "task-state",
          priority: "critical",
          content: taskBlock,
        });
      }
    }

    const taskSpec = taskState?.spec;
    const explicitFiles = taskSpec?.targets?.files ?? [];
    const fallbackFiles =
      explicitFiles.length === 0
        ? this.fileChanges.recentFiles(sessionId, 3)
        : [];
    const viewportFiles =
      explicitFiles.length > 0 ? explicitFiles : fallbackFiles;
    const viewportSymbols = taskSpec?.targets?.symbols ?? [];
    if (viewportFiles.length > 0) {
      const viewportPolicy = this.decideViewportPolicy({
        sessionId,
        goal: taskSpec?.goal || promptText,
        targetFiles: viewportFiles,
        targetSymbols: viewportSymbols,
      });

      this.viewportPolicyBySession.set(sessionId, {
        quality: viewportPolicy.quality,
        score: viewportPolicy.score,
        variant: viewportPolicy.variant,
        updatedAt: Date.now(),
      });

      if (viewportPolicy.guardBlock) {
        this.registerContextInjection(sessionId, {
          source: "brewva.viewport-policy",
          id: "viewport-policy",
          priority: viewportPolicy.variant === "skipped" ? "critical" : "high",
          content: viewportPolicy.guardBlock,
        });
      }

      if (viewportPolicy.selected.text) {
        this.recordEvent({
          sessionId,
          type: "viewport_built",
          turn: this.getCurrentTurn(sessionId),
          payload: {
            goal: taskSpec?.goal || promptText,
            variant: viewportPolicy.variant,
            quality: viewportPolicy.quality,
            score: viewportPolicy.score,
            snr: viewportPolicy.snr,
            effectiveSnr: viewportPolicy.effectiveSnr,
            policyReason: viewportPolicy.reason,
            injected: viewportPolicy.variant !== "skipped",
            requestedFiles: viewportPolicy.selected.metrics.requestedFiles,
            includedFiles: viewportPolicy.selected.metrics.includedFiles,
            unavailableFiles: viewportPolicy.selected.metrics.unavailableFiles,
            importsExportsLines:
              viewportPolicy.selected.metrics.importsExportsLines,
            relevantTotalLines:
              viewportPolicy.selected.metrics.relevantTotalLines,
            relevantHitLines: viewportPolicy.selected.metrics.relevantHitLines,
            symbolLines: viewportPolicy.selected.metrics.symbolLines,
            neighborhoodLines:
              viewportPolicy.selected.metrics.neighborhoodLines,
            totalChars: viewportPolicy.selected.metrics.totalChars,
            truncated: viewportPolicy.selected.metrics.truncated,
          },
        });

        if (viewportPolicy.variant !== "skipped") {
          this.registerContextInjection(sessionId, {
            source: "brewva.viewport",
            id: "viewport",
            priority: "high",
            content: viewportPolicy.selected.text,
          });
        }
      }

      if (
        viewportPolicy.variant !== "full" ||
        viewportPolicy.quality === "low"
      ) {
        this.recordEvent({
          sessionId,
          type: "viewport_policy_evaluated",
          turn: this.getCurrentTurn(sessionId),
          payload: {
            goal: taskSpec?.goal || promptText,
            variant: viewportPolicy.variant,
            quality: viewportPolicy.quality,
            score: viewportPolicy.score,
            snr: viewportPolicy.snr,
            effectiveSnr: viewportPolicy.effectiveSnr,
            reason: viewportPolicy.reason,
            evaluated: viewportPolicy.evaluated.map((entry) => ({
              variant: entry.variant,
              score: entry.score,
              snr: entry.snr,
              effectiveSnr: entry.effectiveSnr,
              truncated: entry.metrics.truncated,
              totalChars: entry.metrics.totalChars,
              importsExportsLines: entry.metrics.importsExportsLines,
              relevantTotalLines: entry.metrics.relevantTotalLines,
              relevantHitLines: entry.metrics.relevantHitLines,
              symbolLines: entry.metrics.symbolLines,
              neighborhoodLines: entry.metrics.neighborhoodLines,
            })),
          },
        });
      }
    }

    const merged = this.contextInjection.plan(
      sessionId,
      this.isContextBudgetEnabled()
        ? this.config.infrastructure.contextBudget.maxInjectionTokens
        : Number.MAX_SAFE_INTEGER,
    );
    const raw = merged.text;
    const decision = this.contextBudget.planInjection(sessionId, raw, usage);
    const wasTruncated = decision.truncated || merged.truncated;
    if (decision.accepted) {
      const fingerprint = sha256(decision.finalText);
      const scopeKey = this.buildInjectionScopeKey(sessionId, injectionScopeId);
      const previous =
        this.lastInjectedContextFingerprintBySession.get(scopeKey);
      if (previous === fingerprint) {
        this.reservedContextInjectionTokensByScope.set(scopeKey, 0);
        this.contextInjection.commit(sessionId, merged.consumedKeys);
        this.recordEvent({
          sessionId,
          type: "context_injection_dropped",
          payload: {
            reason: "duplicate_content",
            originalTokens: decision.originalTokens,
          },
        });
        return {
          text: "",
          accepted: false,
          originalTokens: decision.originalTokens,
          finalTokens: 0,
          truncated: false,
        };
      }

      this.contextInjection.commit(sessionId, merged.consumedKeys);
      this.reservedContextInjectionTokensByScope.set(
        scopeKey,
        this.isContextBudgetEnabled() ? decision.finalTokens : 0,
      );
      this.lastInjectedContextFingerprintBySession.set(scopeKey, fingerprint);
      this.recordEvent({
        sessionId,
        type: "context_injected",
        payload: {
          originalTokens: decision.originalTokens,
          finalTokens: decision.finalTokens,
          truncated: wasTruncated,
          usagePercent: usage?.percent ?? null,
          sourceCount: merged.entries.length,
          sourceTokens: merged.estimatedTokens,
        },
      });
      return {
        text: decision.finalText,
        accepted: true,
        originalTokens: decision.originalTokens,
        finalTokens: decision.finalTokens,
        truncated: wasTruncated,
      };
    }

    const rejectedScopeKey = this.buildInjectionScopeKey(
      sessionId,
      injectionScopeId,
    );
    this.reservedContextInjectionTokensByScope.set(rejectedScopeKey, 0);
    this.recordEvent({
      sessionId,
      type: "context_injection_dropped",
      payload: {
        reason: decision.droppedReason ?? "unknown",
        originalTokens: decision.originalTokens,
      },
    });
    return {
      text: "",
      accepted: false,
      originalTokens: decision.originalTokens,
      finalTokens: 0,
      truncated: false,
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
    const decision = this.contextBudget.planInjection(
      sessionId,
      inputText,
      usage,
    );
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
    const usedTokens =
      this.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
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
    const usedTokens =
      this.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
    const maxTokens = Math.max(
      0,
      Math.floor(this.config.infrastructure.contextBudget.maxInjectionTokens),
    );
    this.reservedContextInjectionTokensByScope.set(
      scopeKey,
      Math.min(maxTokens, usedTokens + normalizedTokens),
    );
  }

  shouldRequestCompaction(
    sessionId: string,
    usage: ContextBudgetUsage | undefined,
  ): boolean {
    const decision = this.contextBudget.shouldRequestCompaction(
      sessionId,
      usage,
    );
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
      const activeAllows =
        activeSkill?.contract.composableWith?.includes(name) ?? false;
      const nextAllows =
        skill.contract.composableWith?.includes(activeName) ?? false;
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
        errors.push(
          `Step ${i + 1}: skill '${step.skill}' not found in registry.`,
        );
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

  getSkillOutputs(
    sessionId: string,
    skillName: string,
  ): Record<string, unknown> | undefined {
    return this.skillOutputsBySession.get(sessionId)?.get(skillName)?.outputs;
  }

  getAvailableConsumedOutputs(
    sessionId: string,
    targetSkillName: string,
  ): Record<string, unknown> {
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

  checkToolAccess(
    sessionId: string,
    toolName: string,
  ): { allowed: boolean; reason?: string } {
    const skill = this.getActiveSkill(sessionId);
    const normalizedToolName = normalizeToolName(toolName);
    const access = checkToolAccess(skill?.contract, toolName, {
      enforceDeniedTools: this.config.security.enforceDeniedTools,
      allowedToolsMode: this.config.security.allowedToolsMode,
      alwaysAllowedTools: ALWAYS_ALLOWED_TOOLS,
    });

    if (access.warning && skill) {
      const key = `${skill.name}:${normalizedToolName}`;
      const seen =
        this.toolContractWarningsBySession.get(sessionId) ?? new Set<string>();
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
    if (budget.blocked) {
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
      const usedTokens = this.costTracker.getSkillTotalTokens(
        sessionId,
        skill.name,
      );
      if (usedTokens >= maxTokens) {
        const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
        if (this.config.security.skillMaxTokensMode === "warn") {
          const key = `maxTokens:${skill.name}`;
          const seen =
            this.skillBudgetWarningsBySession.get(sessionId) ??
            new Set<string>();
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

    const usedCalls = this.toolCallsBySession.get(sessionId) ?? 0;
    if (usedCalls >= skill.contract.budget.maxToolCalls) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill.name,
          reason: `Skill '${skill.name}' exceeded maxToolCalls=${skill.contract.budget.maxToolCalls}.`,
        },
      });
      return {
        allowed: false,
        reason: `Skill '${skill.name}' exceeded maxToolCalls=${skill.contract.budget.maxToolCalls}.`,
      };
    }

    return access;
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
      const activeRuns =
        this.parallel.snapshotSession(sessionId)?.activeRunIds.length ?? 0;
      if (activeRuns >= maxParallel) {
        const mode = this.config.security.skillMaxParallelMode;
        if (mode === "warn") {
          const key = `maxParallel:${skill.name}`;
          const seen =
            this.skillParallelWarningsBySession.get(sessionId) ??
            new Set<string>();
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

  private extractShellCommandFromArgs(
    args: Record<string, unknown>,
  ): string | undefined {
    const candidate = args.command ?? args.cmd ?? args.script;
    if (typeof candidate !== "string") return undefined;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private truthFactIdForCommand(command: string): string {
    const normalized = redactSecrets(command).trim().toLowerCase();
    const digest = sha256(normalized).slice(0, 16);
    return `truth:command:${digest}`;
  }

  private normalizeTruthFilePath(filePath: string): string {
    return resolve(this.cwd, filePath).replace(/\\/g, "/");
  }

  private displayFilePath(filePath: string): string {
    const normalized = resolve(this.cwd, filePath);
    const rel = relative(this.cwd, normalized);
    if (!rel || rel.startsWith("..")) return filePath;
    return rel;
  }

  private truthFactPrefixForDiagnosticFile(filePath: string): string {
    const digest = sha256(this.normalizeTruthFilePath(filePath)).slice(0, 16);
    return `truth:diagnostic:${digest}:`;
  }

  private truthFactIdForDiagnostic(filePath: string, code: string): string {
    const prefix = this.truthFactPrefixForDiagnosticFile(filePath);
    const normalizedCode = code
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    return `${prefix}${normalizedCode || "unknown"}`;
  }

  private redactAndClamp(text: string, maxChars: number): string {
    const redacted = redactSecrets(text);
    const trimmed = redacted.trim();
    if (trimmed.length <= maxChars) return trimmed;
    const keep = Math.max(0, Math.floor(maxChars) - 3);
    return `${trimmed.slice(0, keep)}...`;
  }

  private coerceEvidenceArtifacts(raw: unknown): EvidenceArtifact[] {
    if (!Array.isArray(raw)) return [];
    const out: EvidenceArtifact[] = [];
    for (const entry of raw.slice(0, 24)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const kind = (entry as { kind?: unknown }).kind;
      if (typeof kind !== "string" || kind.trim().length === 0) continue;
      out.push(entry as EvidenceArtifact);
    }
    return out;
  }

  private dedupeArtifacts(artifacts: EvidenceArtifact[]): EvidenceArtifact[] {
    const out: EvidenceArtifact[] = [];
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      let key = "";
      try {
        key = sha256(JSON.stringify(artifact)).slice(0, 16);
      } catch {
        key = `fallback_${Math.random().toString(36).slice(2, 10)}`;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(artifact);
    }
    return out;
  }

  private recordTruthBackedBlocker(
    sessionId: string,
    input: {
      blockerId: string;
      truthFactId: string;
      message: string;
      source: string;
    },
  ): void {
    const current = this.getTaskState(sessionId);
    const existing = current.blockers.find(
      (blocker) => blocker.id === input.blockerId,
    );
    if (
      existing &&
      existing.message === input.message &&
      (existing.source ?? "") === input.source &&
      (existing.truthFactId ?? "") === input.truthFactId
    ) {
      return;
    }
    this.recordTaskBlocker(sessionId, {
      id: input.blockerId,
      message: input.message,
      source: input.source,
      truthFactId: input.truthFactId,
    });
  }

  private resolveTruthBackedBlocker(
    sessionId: string,
    blockerId: string,
  ): void {
    const current = this.getTaskState(sessionId);
    if (!current.blockers.some((blocker) => blocker.id === blockerId)) {
      return;
    }
    this.resolveTaskBlocker(sessionId, blockerId);
  }

  private syncTruthFromToolResult(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    success: boolean;
    ledgerRow: {
      id: string;
      outputHash: string;
      argsSummary: string;
      outputSummary: string;
    };
    metadata?: Record<string, unknown>;
  }): void {
    const normalizedToolName = normalizeToolName(input.toolName);

    const metadataArtifacts = this.coerceEvidenceArtifacts(
      input.metadata?.artifacts,
    );
    const extractedArtifacts = extractEvidenceArtifacts({
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      isError: !input.success,
      details: input.metadata?.details,
    });
    const artifacts = this.dedupeArtifacts([
      ...metadataArtifacts,
      ...extractedArtifacts,
    ]);

    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      const commandFromArgs = this.extractShellCommandFromArgs(input.args);
      const commandFromArtifact = artifacts.find(
        (artifact) => artifact.kind === "command_failure",
      )?.command;
      const command =
        typeof commandFromArtifact === "string" &&
        commandFromArtifact.trim().length > 0
          ? commandFromArtifact.trim()
          : commandFromArgs;
      if (!command) return;

      const commandSummary = this.redactAndClamp(command, 160);
      const commandDetail = this.redactAndClamp(command, 480);
      const truthFactId = this.truthFactIdForCommand(command);

      if (input.success) {
        const truthState = this.getTruthState(input.sessionId);
        const active = truthState.facts.find(
          (fact) => fact.id === truthFactId && fact.status === "active",
        );
        if (active) {
          this.resolveTruthFact(input.sessionId, truthFactId);
        }
        this.resolveTruthBackedBlocker(input.sessionId, truthFactId);
        return;
      }

      const failure = artifacts.find(
        (artifact) => artifact.kind === "command_failure",
      );
      const exitCodeRaw = failure?.exitCode;
      const exitCode =
        typeof exitCodeRaw === "number" && Number.isFinite(exitCodeRaw)
          ? exitCodeRaw
          : null;
      const summary =
        exitCode === null
          ? `command failed: ${commandSummary}`
          : `command failed: ${commandSummary} (exitCode=${exitCode})`;

      this.upsertTruthFact(input.sessionId, {
        id: truthFactId,
        kind: "command_failure",
        severity: "error",
        summary,
        evidenceIds: [input.ledgerRow.id],
        details: {
          tool: input.toolName,
          command: commandDetail,
          exitCode,
          outputHash: input.ledgerRow.outputHash,
          argsSummary: input.ledgerRow.argsSummary,
          outputSummary: input.ledgerRow.outputSummary,
          failingTests: Array.isArray(failure?.failingTests)
            ? failure?.failingTests
            : [],
          failedAssertions: Array.isArray(failure?.failedAssertions)
            ? failure?.failedAssertions
            : [],
          stackTrace: Array.isArray(failure?.stackTrace)
            ? failure?.stackTrace
            : [],
        },
      });

      this.recordTruthBackedBlocker(input.sessionId, {
        blockerId: truthFactId,
        truthFactId,
        message: summary,
        source: "truth_extractor",
      });
    }

    if (normalizedToolName === "lsp_diagnostics") {
      const rawSeverity = input.args.severity;
      const severityFilter =
        typeof rawSeverity === "string" ? rawSeverity.trim() : "";
      const unfiltered =
        severityFilter === "" || severityFilter.toLowerCase() === "all";

      const rawFilePath = input.args.filePath;
      const targetFilePath =
        typeof rawFilePath === "string" ? rawFilePath.trim() : "";
      if (!targetFilePath) return;
      const targetFileKey = this.normalizeTruthFilePath(targetFilePath);
      const targetPrefix = this.truthFactPrefixForDiagnosticFile(targetFileKey);

      const trimmedOutput = input.outputText.trim();
      const outputLower = trimmedOutput.toLowerCase();

      if (unfiltered && outputLower.includes("no diagnostics found")) {
        const truthState = this.getTruthState(input.sessionId);
        for (const fact of truthState.facts) {
          if (fact.status !== "active") continue;
          if (!fact.id.startsWith(targetPrefix)) continue;
          this.resolveTruthFact(input.sessionId, fact.id);
          this.resolveTruthBackedBlocker(input.sessionId, fact.id);
        }
        return;
      }

      if (outputLower.startsWith("error:") || trimmedOutput.length === 0) {
        return;
      }

      type ToolDiagnostic = {
        file: string;
        line: number;
        column: number;
        severity: string;
        code: string;
        message: string;
      };

      const detailsDiagnostics = (() => {
        const details = input.metadata?.details;
        if (!details || typeof details !== "object" || Array.isArray(details)) {
          return null;
        }
        const record = details as Record<string, unknown>;
        if (!Array.isArray(record.diagnostics)) return null;

        const out: ToolDiagnostic[] = [];

        for (const entry of record.diagnostics.slice(0, 240)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
          }
          const diag = entry as Record<string, unknown>;
          const file = typeof diag.file === "string" ? diag.file.trim() : "";
          const line = typeof diag.line === "number" ? diag.line : NaN;
          const column = typeof diag.column === "number" ? diag.column : NaN;
          const severity =
            typeof diag.severity === "string" ? diag.severity.trim() : "";
          const code = typeof diag.code === "string" ? diag.code.trim() : "";
          const message =
            typeof diag.message === "string" ? diag.message.trim() : "";

          if (
            !file ||
            !Number.isFinite(line) ||
            !Number.isFinite(column) ||
            !code ||
            !message
          ) {
            continue;
          }
          out.push({
            file,
            line,
            column,
            severity: severity || "unknown",
            code,
            message,
          });
        }

        return {
          diagnostics: out,
          truncated: Boolean(record.truncated),
        };
      })();

      let diagnostics: ToolDiagnostic[] = [];
      let diagnosticsTruncated = false;
      if (detailsDiagnostics) {
        diagnostics = detailsDiagnostics.diagnostics;
        diagnosticsTruncated = detailsDiagnostics.truncated;
      } else {
        const parsed = parseTscDiagnostics(input.outputText, 240);
        diagnostics = parsed.diagnostics;
        diagnosticsTruncated = parsed.truncated;
      }

      diagnostics = diagnostics.filter(
        (diagnostic) =>
          this.normalizeTruthFilePath(diagnostic.file) === targetFileKey,
      );
      if (diagnostics.length === 0) {
        return;
      }

      type TruthDiagnosticSample = {
        line: number;
        column: number;
        message: string;
      };
      type CodeAggregate = {
        count: number;
        severity: TruthFactSeverity;
        samples: TruthDiagnosticSample[];
      };

      const aggregates = new Map<string, CodeAggregate>();
      for (const diagnostic of diagnostics) {
        const code = diagnostic.code.trim();
        if (!code) continue;

        const truthSeverity: TruthFactSeverity =
          diagnostic.severity === "error"
            ? "error"
            : diagnostic.severity === "warning"
              ? "warn"
              : "info";

        const bucket = aggregates.get(code) ?? {
          count: 0,
          severity: truthSeverity,
          samples: [],
        };

        bucket.count += 1;
        if (bucket.severity !== "error" && truthSeverity === "error") {
          bucket.severity = "error";
        }
        if (bucket.severity === "info" && truthSeverity === "warn") {
          bucket.severity = "warn";
        }

        if (bucket.samples.length < 3) {
          bucket.samples.push({
            line: diagnostic.line,
            column: diagnostic.column,
            message: diagnostic.message,
          });
        }

        aggregates.set(code, bucket);
      }

      if (aggregates.size === 0) return;

      const fileDisplay = this.displayFilePath(targetFileKey);
      const currentFactIds = new Set<string>();

      for (const [code, aggregate] of aggregates.entries()) {
        const truthFactId = this.truthFactIdForDiagnostic(targetFileKey, code);
        currentFactIds.add(truthFactId);

        const summary = `diagnostic: ${fileDisplay} ${code} x${aggregate.count}`;

        this.upsertTruthFact(input.sessionId, {
          id: truthFactId,
          kind: "diagnostic",
          severity: aggregate.severity,
          summary,
          evidenceIds: [input.ledgerRow.id],
          details: {
            tool: input.toolName,
            compiler: "tsc",
            severityFilter: severityFilter || null,
            file: fileDisplay,
            code,
            count: aggregate.count,
            samples: aggregate.samples,
            outputHash: input.ledgerRow.outputHash,
            argsSummary: input.ledgerRow.argsSummary,
            outputSummary: input.ledgerRow.outputSummary,
            truncated: diagnosticsTruncated,
          },
        });

        this.recordTruthBackedBlocker(input.sessionId, {
          blockerId: truthFactId,
          truthFactId,
          message: summary,
          source: "truth_extractor",
        });
      }

      if (unfiltered) {
        const truthState = this.getTruthState(input.sessionId);
        for (const fact of truthState.facts) {
          if (fact.status !== "active") continue;
          if (!fact.id.startsWith(targetPrefix)) continue;
          if (currentFactIds.has(fact.id)) continue;
          this.resolveTruthFact(input.sessionId, fact.id);
          this.resolveTruthBackedBlocker(input.sessionId, fact.id);
        }
      }
    }
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

    this.syncTruthFromToolResult({
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

  resolveTaskBlocker(
    sessionId: string,
    blockerId: string,
  ): { ok: boolean; error?: string } {
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
      lastCheckpointIndex >= 0
        ? Math.max(0, totalEntries - lastCheckpointIndex - 1)
        : totalEntries;

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
      return [
        "anchor",
        payload.name,
        payload.summary ?? "",
        payload.nextSteps ?? "",
      ]
        .join(" ")
        .trim();
    }
    const payloadText =
      event.payload && Object.keys(event.payload).length > 0
        ? JSON.stringify(event.payload)
        : "";
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
      ...new Set([
        ...(existing?.evidenceIds ?? []),
        ...(input.evidenceIds ?? []),
      ]),
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
      resolvedAt:
        status === "resolved" ? (existing?.resolvedAt ?? now) : undefined,
    };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactUpsertedEvent(fact) as unknown as Record<
        string,
        unknown
      >,
    });
    return { ok: true, fact };
  }

  resolveTruthFact(
    sessionId: string,
    truthFactId: string,
  ): { ok: boolean; error?: string } {
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

  queryEvents(
    sessionId: string,
    query: BrewvaEventQuery = {},
  ): BrewvaEventRecord[] {
    return this.events.list(sessionId, query);
  }

  queryStructuredEvents(
    sessionId: string,
    query: BrewvaEventQuery = {},
  ): BrewvaStructuredEvent[] {
    return this.events
      .list(sessionId, query)
      .map((event) => this.toStructuredEvent(event));
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

  subscribeEvents(
    listener: (event: BrewvaStructuredEvent) => void,
  ): () => void {
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

  evaluateCompletion(
    sessionId: string,
    level?: VerificationLevel,
  ): VerificationReport {
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

  private syncVerificationBlockers(
    sessionId: string,
    report: VerificationReport,
  ): void {
    const verificationState = this.verification.stateStore.get(sessionId);
    if (!verificationState.lastWriteAt) return;

    const lastWriteAt = verificationState.lastWriteAt ?? 0;
    const current = this.getTaskState(sessionId);
    const existingById = new Map(
      current.blockers.map((blocker) => [blocker.id, blocker]),
    );
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
        blocker.truthFactId ??
        `truth:verifier:${blocker.id.slice(VERIFIER_BLOCKER_PREFIX.length)}`;
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
      const isFresh =
        existing && existing.ok && existing.timestamp >= state.lastWriteAt;
      if (isFresh) continue;

      const result = await runShellCommand(command, {
        cwd: this.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputChars: 200_000,
      });

      const ok = result.exitCode === 0 && !result.timedOut;
      const outputText = `${result.stdout}\n${result.stderr}`.trim();
      const outputSummary =
        outputText.length > 0
          ? outputText.slice(0, 2000)
          : ok
            ? "(no output)"
            : "(no output)";

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
    const every = Math.max(
      0,
      Math.trunc(this.config.ledger.checkpointEveryTurns),
    );
    if (every <= 0) return;
    if (turn <= 0) return;
    if (turn % every !== 0) return;
    if (this.lastLedgerCompactionTurnBySession.get(sessionId) === turn) {
      return;
    }

    const keepLast = Math.max(
      2,
      Math.min(this.config.ledger.digestWindow, every - 1),
    );
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
