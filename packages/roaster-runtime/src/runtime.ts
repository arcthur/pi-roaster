import { resolve } from "node:path";
	import type {
	  ContextBudgetUsage,
	  EvidenceQuery,
	  ParallelAcquireResult,
	  RollbackResult,
  RoasterEventCategory,
  RoasterEventQuery,
  RoasterEventRecord,
  RoasterReplaySession,
  RoasterConfig,
  RoasterStructuredEvent,
  RuntimeSessionRestoreResult,
  RuntimeSessionSnapshot,
  SkillDocument,
  SkillOutputRecord,
	  SkillSelection,
	  SessionCostSummary,
	  TaskSpec,
		  TaskState,
		  VerificationLevel,
		  VerificationReport,
		  VerificationCheckRun,
		  WorkerMergeReport,
		  WorkerResult,
		} from "./types.js";
import type { TaskItemStatus } from "./types.js";
import { loadRoasterConfig } from "./config/loader.js";
import { SkillRegistry } from "./skills/registry.js";
import { selectTopKSkills } from "./skills/selector.js";
import { EvidenceLedger } from "./ledger/evidence-ledger.js";
import { buildLedgerDigest } from "./ledger/digest.js";
import { formatLedgerRows } from "./ledger/query.js";
import { classifyEvidence, isMutationTool } from "./verification/classifier.js";
import { VerificationGate } from "./verification/gate.js";
import { ParallelBudgetManager } from "./parallel/budget.js";
import { ParallelResultStore } from "./parallel/results.js";
import { sanitizeContextText } from "./security/sanitize.js";
import { checkToolAccess } from "./security/tool-policy.js";
	import { runShellCommand } from "./utils/exec.js";
	import { ContextBudgetManager } from "./context/budget.js";
	import { ContextInjectionCollector, type ContextInjectionPriority } from "./context/injection.js";
	import { buildViewportContext } from "./context/viewport.js";
	import { buildTruthLedgerBlock } from "./context/truth.js";
	import { RoasterEventStore } from "./events/store.js";
import { SessionSnapshotStore } from "./state/snapshot-store.js";
import { FileChangeTracker } from "./state/file-change-tracker.js";
import { createTaskLedgerSnapshotStore, type TaskLedgerSnapshotStore } from "./state/task-ledger-snapshot-store.js";
	import { SessionCostTracker } from "./cost/tracker.js";
	import { sha256 } from "./utils/hash.js";
	import { estimateTokenCount, truncateTextToTokenBudget } from "./utils/token.js";
	import {
	  TASK_EVENT_TYPE,
	  buildBlockerRecordedEvent,
	  buildBlockerResolvedEvent,
	  buildItemAddedEvent,
	  buildItemUpdatedEvent,
	  coerceTaskLedgerPayload,
	  createEmptyTaskState,
	  foldTaskLedgerEvents,
	  reduceTaskState,
	} from "./task/ledger.js";
	import { normalizeTaskSpec } from "./task/spec.js";

const ALWAYS_ALLOWED_TOOLS = ["skill_complete", "skill_load", "ledger_query", "cost_view", "rollback_last_patch"];
const ALWAYS_ALLOWED_TOOL_SET = new Set(ALWAYS_ALLOWED_TOOLS);

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
  evidence?: string;
  run?: VerificationCheckRun;
}): string {
  const lines: string[] = [`verification failed: ${input.checkName}`];
  if (input.run) {
    if (input.run.ledgerId) {
      lines.push(`ledgerId: ${input.run.ledgerId}`);
    }
    lines.push(`command: ${input.run.command}`);
    lines.push(`exitCode: ${input.run.exitCode ?? "null"}`);
    const output = typeof input.run.outputSummary === "string" && input.run.outputSummary.length > 0 ? input.run.outputSummary : "(no output)";
    const capped = output.length > 1800 ? `${output.slice(0, 1797)}...` : output;
    lines.push("output:");
    lines.push(capped);
    return lines.join("\n");
  }

  if (input.evidence) {
    lines.push("evidence:");
    lines.push(input.evidence);
  }
  return lines.join("\n");
}

export interface RoasterRuntimeOptions {
  cwd?: string;
  configPath?: string;
  config?: RoasterConfig;
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

function inferEventCategory(type: string): RoasterEventCategory {
  if (type.startsWith("session_") || type === "session_start" || type === "session_shutdown") return "session";
  if (type.startsWith("turn_")) return "turn";
  if (type.includes("tool") || type.startsWith("patch_") || type === "rollback") return "tool";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("cost_") || type.startsWith("budget_")) return "cost";
  if (type.startsWith("verification_")) return "verification";
  if (type.includes("snapshot") || type.includes("resumed") || type.includes("interrupted")) return "state";
  return "other";
}

function buildSkillCandidateBlock(selected: SkillSelection[]): string {
  const skillLines =
    selected.length > 0
      ? selected.map((entry) => `- ${entry.name} (score=${entry.score}, reason=${entry.reason})`)
      : ["- (none)"];
  return ["[Roaster Context]", "Top-K Skill Candidates:", ...skillLines].join("\n");
}

function buildTaskStateBlock(state: TaskState): string {
  const hasAny =
    Boolean(state.spec) || (state.items?.length ?? 0) > 0 || (state.blockers?.length ?? 0) > 0;
  if (!hasAny) return "";

  const spec = state.spec;
  const lines: string[] = ["[TaskLedger]"];
  if (spec) {
    lines.push(`goal=${spec.goal}`);
    if (spec.expectedBehavior) {
      lines.push(`expectedBehavior=${spec.expectedBehavior}`);
    }

    const files = spec.targets?.files ?? [];
    const symbols = spec.targets?.symbols ?? [];
    if (files.length > 0) {
      lines.push("targets.files:");
      for (const file of files.slice(0, 8)) {
        lines.push(`- ${file}`);
      }
    }
    if (symbols.length > 0) {
      lines.push("targets.symbols:");
      for (const symbol of symbols.slice(0, 8)) {
        lines.push(`- ${symbol}`);
      }
    }

    const constraints = spec.constraints ?? [];
    if (constraints.length > 0) {
      lines.push("constraints:");
      for (const constraint of constraints.slice(0, 8)) {
        lines.push(`- ${constraint}`);
      }
    }
  }

  const blockers = state.blockers ?? [];
  if (blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of blockers.slice(0, 4)) {
      const source = blocker.source ? ` source=${blocker.source}` : "";
      const messageLines = blocker.message.split("\n");
      const firstLine = messageLines[0] ?? "";
      lines.push(`- [${blocker.id}] ${firstLine}${source}`.trim());
      for (const line of messageLines.slice(1)) {
        lines.push(`  ${line}`);
      }
    }
  }

  const items = state.items ?? [];
  const open = items.filter((item) => item.status !== "done").slice(0, 6);
  if (open.length > 0) {
    lines.push("openItems:");
    for (const item of open) {
      lines.push(`- [${item.status}] ${item.text}`);
    }
  }

  const verification = spec?.verification;
  if (verification?.level) {
    lines.push(`verification.level=${verification.level}`);
  }
  if (verification?.commands && verification.commands.length > 0) {
    lines.push("verification.commands:");
    for (const command of verification.commands.slice(0, 4)) {
      lines.push(`- ${command}`);
    }
  }

  return lines.join("\n");
}

function buildContextSourceTokenLimits(maxInjectionTokens: number): Record<string, number> {
  const budget = Math.max(64, Math.floor(maxInjectionTokens));
  const fromRatio = (ratio: number, minimum: number, maximum = budget): number => {
    const scaled = Math.floor(budget * ratio);
    return Math.max(minimum, Math.min(maximum, scaled));
  };

  return {
    "roaster.truth": fromRatio(0.05, 48, 200),
    "roaster.task-state": fromRatio(0.15, 96, 360),
    "roaster.viewport": fromRatio(0.7, 240, budget),
    "roaster.skill-candidates": fromRatio(0.28, 64, 320),
    "roaster.resume-hint": fromRatio(0.4, 96, 480),
    "roaster.compaction-summary": fromRatio(0.45, 120, 600),
    "roaster.ledger-digest": fromRatio(0.2, 96, 360),
  };
}

export class RoasterRuntime {
  readonly cwd: string;
  readonly config: RoasterConfig;
  readonly skills: SkillRegistry;
  readonly ledger: EvidenceLedger;
  readonly verification: VerificationGate;
  readonly parallel: ParallelBudgetManager;
  readonly parallelResults: ParallelResultStore;
  readonly events: RoasterEventStore;
  readonly contextBudget: ContextBudgetManager;
  readonly contextInjection: ContextInjectionCollector;
  readonly snapshots: SessionSnapshotStore;
  readonly taskLedgerSnapshots: TaskLedgerSnapshotStore;
  readonly fileChanges: FileChangeTracker;
  readonly costTracker: SessionCostTracker;

  private activeSkillsBySession = new Map<string, string>();
  private turnsBySession = new Map<string, number>();
  private toolCallsBySession = new Map<string, number>();
  private resumeHintsBySession = new Map<string, string>();
  private latestCompactionSummaryBySession = new Map<string, { entryId?: string; summary: string }>();
  private lastInjectedContextFingerprintBySession = new Map<string, string>();
  private reservedContextInjectionTokensByScope = new Map<string, number>();
  private lastLedgerCompactionTurnBySession = new Map<string, number>();
	  private toolContractWarningsBySession = new Map<string, Set<string>>();
	  private skillBudgetWarningsBySession = new Map<string, Set<string>>();
	  private skillParallelWarningsBySession = new Map<string, Set<string>>();
	  private skillOutputsBySession = new Map<string, Map<string, SkillOutputRecord>>();
	  private taskStateBySession = new Map<string, TaskState>();
	  private eventListeners = new Set<(event: RoasterStructuredEvent) => void>();

  constructor(options: RoasterRuntimeOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.config = options.config ?? loadRoasterConfig({ cwd: this.cwd, configPath: options.configPath });

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
    this.events = new RoasterEventStore(this.config.infrastructure.events, this.cwd);
    this.contextBudget = new ContextBudgetManager(this.config.infrastructure.contextBudget);
    this.contextInjection = new ContextInjectionCollector({
      sourceTokenLimits: this.isContextBudgetEnabled()
        ? buildContextSourceTokenLimits(this.config.infrastructure.contextBudget.maxInjectionTokens)
        : {},
      truncationStrategy: this.config.infrastructure.contextBudget.truncationStrategy,
    });
    this.snapshots = new SessionSnapshotStore(this.config.infrastructure.interruptRecovery, this.cwd);
    this.taskLedgerSnapshots = createTaskLedgerSnapshotStore(this.config, this.cwd);
    this.fileChanges = new FileChangeTracker(this.cwd);
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

  buildContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
    injectionScopeId?: string,
  ): { text: string; accepted: boolean; originalTokens: number; finalTokens: number; truncated: boolean } {
    const promptText = this.sanitizeInput(prompt);
    const truthBlock = buildTruthLedgerBlock({ cwd: this.cwd });
    if (truthBlock) {
      this.registerContextInjection(sessionId, {
        source: "roaster.truth",
        id: "truth-ledger",
        priority: "critical",
        oncePerSession: true,
        content: truthBlock,
      });
    }
    const selected = this.selectSkills(promptText);
    const digest = this.getLedgerDigest(sessionId);
    const resumeHint = this.getResumeHint(sessionId);
    this.registerContextInjection(sessionId, {
      source: "roaster.skill-candidates",
      id: "top-k-skills",
      priority: "high",
      content: buildSkillCandidateBlock(selected),
    });
    this.registerContextInjection(sessionId, {
      source: "roaster.ledger-digest",
      id: "ledger-digest",
      priority: "normal",
      content: digest,
    });

    if (resumeHint) {
      this.registerContextInjection(sessionId, {
        source: "roaster.resume-hint",
        id: "resume-hint",
        priority: "critical",
        content: `[ResumeHint]\n${resumeHint}`,
      });
    }

	    const latestCompaction = this.latestCompactionSummaryBySession.get(sessionId);
	    if (latestCompaction?.summary) {
	      this.registerContextInjection(sessionId, {
	        source: "roaster.compaction-summary",
	        id: latestCompaction.entryId ?? "latest",
	        priority: "high",
	        oncePerSession: true,
	        content: `[CompactionSummary]\n${latestCompaction.summary}`,
	      });
		    }

		    const taskState = this.taskStateBySession.get(sessionId);
		    if (taskState && (taskState.spec || taskState.items.length > 0 || taskState.blockers.length > 0)) {
		      const taskBlock = buildTaskStateBlock(taskState);
		      if (taskBlock) {
		        this.registerContextInjection(sessionId, {
		          source: "roaster.task-state",
	          id: "task-state",
	          priority: "critical",
	          content: taskBlock,
	        });
	      }
	    }

	    const taskSpec = taskState?.spec;
	    const explicitFiles = taskSpec?.targets?.files ?? [];
	    const fallbackFiles = explicitFiles.length === 0 ? this.fileChanges.recentFiles(sessionId, 3) : [];
	    const viewportFiles = explicitFiles.length > 0 ? explicitFiles : fallbackFiles;
	    const viewportSymbols = taskSpec?.targets?.symbols ?? [];
	    if (viewportFiles.length > 0) {
	      const viewport = buildViewportContext({
	        cwd: this.cwd,
	        goal: taskSpec?.goal || promptText,
	        targetFiles: viewportFiles,
	        targetSymbols: viewportSymbols,
	      });
	      if (viewport) {
	        this.registerContextInjection(sessionId, {
	          source: "roaster.viewport",
	          id: "viewport",
	          priority: "high",
	          content: viewport,
	        });
	      }
	    }

	    const merged = this.contextInjection.plan(
	      sessionId,
	      this.isContextBudgetEnabled() ? this.config.infrastructure.contextBudget.maxInjectionTokens : Number.MAX_SAFE_INTEGER,
	    );
    const raw = merged.text;
    const decision = this.contextBudget.planInjection(sessionId, raw, usage);
    const wasTruncated = decision.truncated || merged.truncated;
    if (decision.accepted) {
      const fingerprint = sha256(decision.finalText);
      const scopeKey = this.buildInjectionScopeKey(sessionId, injectionScopeId);
      const previous = this.lastInjectedContextFingerprintBySession.get(scopeKey);
      if (previous === fingerprint) {
        this.reservedContextInjectionTokensByScope.set(scopeKey, 0);
        this.contextInjection.commit(sessionId, merged.consumedKeys);
        if (resumeHint) {
          this.clearResumeHint(sessionId);
        }
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
      if (resumeHint) {
        this.clearResumeHint(sessionId);
      }
      this.reservedContextInjectionTokensByScope.set(scopeKey, this.isContextBudgetEnabled() ? decision.finalTokens : 0);
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

    const rejectedScopeKey = this.buildInjectionScopeKey(sessionId, injectionScopeId);
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
    const maxTokens = Math.max(0, Math.floor(this.config.infrastructure.contextBudget.maxInjectionTokens));
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

  commitSupplementalContextInjection(sessionId: string, finalTokens: number, injectionScopeId?: string): void {
    if (!this.isContextBudgetEnabled()) {
      return;
    }

    const normalizedTokens = Math.max(0, Math.floor(finalTokens));
    if (normalizedTokens <= 0) return;

    const scopeKey = this.buildInjectionScopeKey(sessionId, injectionScopeId);
    const usedTokens = this.reservedContextInjectionTokensByScope.get(scopeKey) ?? 0;
    const maxTokens = Math.max(0, Math.floor(this.config.infrastructure.contextBudget.maxInjectionTokens));
    this.reservedContextInjectionTokensByScope.set(scopeKey, Math.min(maxTokens, usedTokens + normalizedTokens));
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

  markContextCompacted(
    sessionId: string,
    input: { fromTokens?: number | null; toTokens?: number | null; summary?: string; entryId?: string },
  ): void {
    this.contextBudget.markCompacted(sessionId);
    this.contextInjection.resetOncePerSession(sessionId);
    this.clearInjectionFingerprintsForSession(sessionId);
    this.clearReservedInjectionTokensForSession(sessionId);
    const turn = this.getCurrentTurn(sessionId);
    const summary = input.summary?.trim();
    const entryId = input.entryId?.trim();
    if (summary) {
      this.latestCompactionSummaryBySession.set(sessionId, { entryId, summary });
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
      tool: "roaster_context_compaction",
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

  activateSkill(sessionId: string, name: string): { ok: boolean; reason?: string; skill?: SkillDocument } {
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

  validateSkillOutputs(sessionId: string, outputs: Record<string, unknown>): { ok: boolean; missing: string[] } {
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
      if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
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

  completeSkill(sessionId: string, outputs: Record<string, unknown>): { ok: boolean; missing: string[] } {
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

    if (this.config.security.skillMaxTokensMode !== "off" && !ALWAYS_ALLOWED_TOOL_SET.has(normalizedToolName)) {
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
      tool: "roaster_rollback",
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
        schema: "roaster.task.ledger.v1",
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
    input: { id?: string; message: string; source?: string },
  ): { ok: boolean; blockerId?: string; error?: string } {
    const message = input.message?.trim();
    if (!message) {
      return { ok: false, error: "missing_message" };
    }

    const payload = buildBlockerRecordedEvent({
      id: input.id?.trim() || undefined,
      message,
      source: input.source?.trim() || undefined,
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

  getTaskState(sessionId: string): TaskState {
    const cached = this.taskStateBySession.get(sessionId);
    if (cached) {
      return {
        spec: cached.spec,
        items: [...cached.items],
        blockers: [...cached.blockers],
        updatedAt: cached.updatedAt,
      };
    }

    const hydrated = this.taskLedgerSnapshots.hydrate(sessionId);
    if (hydrated) {
      this.taskStateBySession.set(sessionId, hydrated);
      return {
        spec: hydrated.spec,
        items: [...hydrated.items],
        blockers: [...hydrated.blockers],
        updatedAt: hydrated.updatedAt,
      };
    }

    const events = this.queryEvents(sessionId, { type: TASK_EVENT_TYPE });
    const state = foldTaskLedgerEvents(events);
    this.taskStateBySession.set(sessionId, state);
    try {
      this.taskLedgerSnapshots.save(sessionId, state);
    } catch {
      // ignore snapshot IO failures
    }
    return {
      spec: state.spec,
      items: [...state.items],
      blockers: [...state.blockers],
      updatedAt: state.updatedAt,
    };
  }

  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
  }): RoasterEventRecord | undefined {
    const row = this.events.append({
      sessionId: input.sessionId,
      type: input.type,
      turn: input.turn,
      payload: input.payload,
      timestamp: input.timestamp,
    });
    if (!row) return undefined;

    this.tryApplyTaskEvent(row);

    const structured = this.toStructuredEvent(row);
    for (const listener of this.eventListeners.values()) {
      listener(structured);
    }
    return row;
  }

  queryEvents(sessionId: string, query: RoasterEventQuery = {}): RoasterEventRecord[] {
    return this.events.list(sessionId, query);
  }

  queryStructuredEvents(sessionId: string, query: RoasterEventQuery = {}): RoasterStructuredEvent[] {
    return this.events.list(sessionId, query).map((event) => this.toStructuredEvent(event));
  }

  listReplaySessions(limit = 20): RoasterReplaySession[] {
    const sessionIds = this.events.listSessionIds();
    const rows: RoasterReplaySession[] = [];

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

  subscribeEvents(listener: (event: RoasterStructuredEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  toStructuredEvent(event: RoasterEventRecord): RoasterStructuredEvent {
    return {
      schema: "roaster.event.v1",
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
      tool: "roaster_cost",
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

  restoreSessionSnapshot(sessionId: string): RuntimeSessionRestoreResult {
    const snapshot = this.snapshots.load(sessionId);
    if (!snapshot) {
      return { restored: false };
    }
    return this.applySnapshotToSession({
      targetSessionId: sessionId,
      snapshot,
      sourceSessionId: sessionId,
    });
  }

  restoreStartupSession(sessionId: string): RuntimeSessionRestoreResult {
    const direct = this.snapshots.load(sessionId);
    if (direct) {
      return this.applySnapshotToSession({
        targetSessionId: sessionId,
        snapshot: direct,
        sourceSessionId: sessionId,
      });
    }

    const latestInterrupted = this.snapshots.latestInterrupted();
    if (!latestInterrupted) {
      return { restored: false };
    }

    const restored = this.applySnapshotToSession({
      targetSessionId: sessionId,
      snapshot: latestInterrupted,
      sourceSessionId: latestInterrupted.sessionId,
      imported: latestInterrupted.sessionId !== sessionId,
    });
    if (restored.restored && latestInterrupted.sessionId !== sessionId) {
      this.persistSessionSnapshot(sessionId, {
        reason: "manual",
        interrupted: false,
      });
      this.snapshots.remove(latestInterrupted.sessionId);
    }
    return restored;
  }

  private applySnapshotToSession(input: {
    targetSessionId: string;
    snapshot: RuntimeSessionSnapshot;
    sourceSessionId: string;
    imported?: boolean;
  }): RuntimeSessionRestoreResult {
    const { targetSessionId, snapshot } = input;
    if (snapshot.activeSkill) {
      this.activeSkillsBySession.set(targetSessionId, snapshot.activeSkill);
    } else {
      this.activeSkillsBySession.delete(targetSessionId);
    }
    this.turnsBySession.set(targetSessionId, snapshot.turnCounter);
    this.toolCallsBySession.set(targetSessionId, snapshot.toolCalls);
	    this.verification.stateStore.restore(targetSessionId, snapshot.verification);
	    const droppedActiveRuns = this.parallel.restoreSession(targetSessionId, snapshot.parallel);
	    this.contextBudget.restoreSession(targetSessionId, snapshot.contextBudget);
	    this.costTracker.restore(targetSessionId, snapshot.cost);
	    if (snapshot.task?.state) {
	      this.taskStateBySession.set(targetSessionId, snapshot.task.state);
	      try {
	        this.taskLedgerSnapshots.save(targetSessionId, snapshot.task.state);
	      } catch {
	        // ignore snapshot IO failures
	      }
	    } else {
	      this.taskStateBySession.delete(targetSessionId);
	    }
	    const importedPatchSets = input.imported
	      ? this.fileChanges.importSessionHistory(input.sourceSessionId, targetSessionId).importedPatchSets
	      : 0;

    if (snapshot.interrupted && this.shouldInjectResumeHint()) {
      const hint = [
        `Session recovered from interruption at ${new Date(snapshot.createdAt).toISOString()}.`,
        `Last active skill: ${snapshot.activeSkill ?? "(none)"}.`,
        `Tool calls used: ${snapshot.toolCalls}.`,
        `Turn counter: ${snapshot.turnCounter}.`,
        input.imported ? `Recovered from previous session ${input.sourceSessionId}.` : "",
      ].join(" ");
      this.resumeHintsBySession.set(targetSessionId, hint);
    }

    this.recordEvent({
      sessionId: targetSessionId,
      type: "session_resumed",
      payload: {
        snapshotAt: snapshot.createdAt,
        reason: snapshot.reason,
        interrupted: snapshot.interrupted,
        activeSkill: snapshot.activeSkill ?? null,
        droppedActiveRuns,
        snapshotSessionId: input.sourceSessionId,
        imported: input.imported ?? false,
        importedPatchSets,
      },
    });

    return { restored: true, snapshot };
  }

  persistSessionSnapshot(
    sessionId: string,
    options: { reason: "signal" | "shutdown" | "manual"; interrupted?: boolean } = { reason: "manual" },
  ): void {
    const lastEvent = this.events.latest(sessionId);
    const taskState = this.taskStateBySession.get(sessionId);
    const taskSnapshot =
      taskState && (taskState.spec || taskState.items.length > 0 || taskState.blockers.length > 0)
        ? {
            schema: "roaster.task.snapshot.v1" as const,
            state: taskState,
          }
        : undefined;
    const snapshot = {
      version: 1 as const,
      sessionId,
      createdAt: Date.now(),
      reason: options.reason,
      interrupted: options.interrupted ?? false,
      activeSkill: this.activeSkillsBySession.get(sessionId),
      toolCalls: this.toolCallsBySession.get(sessionId) ?? 0,
      turnCounter: this.turnsBySession.get(sessionId) ?? 0,
      verification: this.verification.stateStore.snapshot(sessionId),
      parallel: this.parallel.snapshotSession(sessionId),
      contextBudget: this.contextBudget.snapshotSession(sessionId),
      cost: this.costTracker.getSummary(sessionId),
      task: taskSnapshot,
      lastEvent: lastEvent
        ? {
            id: lastEvent.id,
            type: lastEvent.type,
            timestamp: lastEvent.timestamp,
          }
        : undefined,
    };
    this.snapshots.save(snapshot);
    if (taskState && (taskState.spec || taskState.items.length > 0 || taskState.blockers.length > 0)) {
      try {
        const compaction = this.taskLedgerSnapshots.maybeCompact(sessionId, taskState);
        if (compaction) {
          this.recordEvent({
            sessionId,
            type: "task_ledger_compacted",
            turn: this.getCurrentTurn(sessionId),
            payload: {
              compacted: compaction.compacted,
              kept: compaction.kept,
              bytesBefore: compaction.bytesBefore,
              bytesAfter: compaction.bytesAfter,
              durationMs: compaction.durationMs,
              checkpointEventId: compaction.checkpointEventId,
              trigger: options.reason,
            },
          });
        }
      } catch {
        // ignore task ledger compaction failures
      }
    }
    this.recordEvent({
      sessionId,
      type: "session_snapshot_saved",
      payload: {
        reason: options.reason,
        interrupted: options.interrupted ?? false,
      },
    });
  }

	  clearSessionSnapshot(sessionId: string): void {
	    this.snapshots.remove(sessionId);
	    this.taskLedgerSnapshots.remove(sessionId);
	    this.fileChanges.clearSession(sessionId);
	    this.lastLedgerCompactionTurnBySession.delete(sessionId);
	    this.contextInjection.clearSession(sessionId);
	    this.latestCompactionSummaryBySession.delete(sessionId);
	    this.clearInjectionFingerprintsForSession(sessionId);
	    this.clearReservedInjectionTokensForSession(sessionId);
	    this.taskStateBySession.delete(sessionId);
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

	    const report = this.verification.evaluate(sessionId, effectiveLevel, { requireCommands: executeCommands });
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

	    for (const check of report.checks) {
	      if (check.status !== "fail") continue;

	      const blockerId = `${VERIFIER_BLOCKER_PREFIX}${normalizeVerifierCheckForId(check.name)}`;
	      failingIds.add(blockerId);

	      const run = verificationState.checkRuns[check.name];
	      const freshRun = run && run.timestamp >= lastWriteAt ? run : undefined;
	      const message = buildVerifierBlockerMessage({ checkName: check.name, evidence: check.evidence, run: freshRun });
	      const source = "verification_gate";

	      const existing = existingById.get(blockerId);
	      if (existing && existing.message === message && (existing.source ?? "") === source) {
	        continue;
	      }
	      this.recordTaskBlocker(sessionId, {
	        id: blockerId,
	        message,
	        source,
	      });
	    }

	    for (const blocker of current.blockers) {
	      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) continue;
	      if (failingIds.has(blocker.id)) continue;
	      this.resolveTaskBlocker(sessionId, blocker.id);
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
	      const outputSummary = outputText.length > 0 ? outputText.slice(0, 2000) : ok ? "(no output)" : "(no output)";

	      const timestamp = Date.now();
	      const ledgerId = this.recordToolResult({
	        sessionId,
	        toolName: "roaster_verify",
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

  private getResumeHint(sessionId: string): string | undefined {
    return this.resumeHintsBySession.get(sessionId);
  }

  private tryApplyTaskEvent(event: RoasterEventRecord): void {
    if (event.type !== TASK_EVENT_TYPE) {
      return;
    }

    const payload = coerceTaskLedgerPayload(event.payload);
    if (!payload) {
      return;
    }

    const current = this.taskStateBySession.get(event.sessionId) ?? createEmptyTaskState();
    const next = reduceTaskState(current, payload, event.timestamp);
    this.taskStateBySession.set(event.sessionId, next);
    try {
      this.taskLedgerSnapshots.save(event.sessionId, next);
    } catch {
      // ignore snapshot IO failures
    }
  }

  private clearResumeHint(sessionId: string): void {
    this.resumeHintsBySession.delete(sessionId);
  }

  private shouldInjectResumeHint(): boolean {
    const setting = this.config.infrastructure.interruptRecovery.resumeHintInjectionEnabled;
    if (typeof setting === "boolean") return setting;
    const legacy = this.config.infrastructure.interruptRecovery.resumeHintInSystemPrompt;
    return typeof legacy === "boolean" ? legacy : true;
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
