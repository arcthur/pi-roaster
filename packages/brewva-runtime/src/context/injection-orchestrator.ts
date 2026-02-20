import type { ViewportQuality } from "../policy/viewport-policy.js";
import type {
  ContextBudgetUsage,
  ContextInjectionDecision,
  SkillSelection,
  TaskState,
  TruthState,
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import type { ContextInjectionPlanResult, RegisterContextInjectionInput } from "./injection.js";
import { buildTruthFactsBlock } from "./truth-facts.js";
import { buildTruthLedgerBlock } from "./truth.js";
import { buildOutputHealthGuardBlock, decideViewportPolicy } from "./viewport-orchestrator.js";

const OUTPUT_HEALTH_GUARD_SCORE_THRESHOLD = 0.4;

type ViewportPolicySnapshot = {
  quality: ViewportQuality;
  score: number | null;
  variant: string;
  updatedAt: number;
};

export interface BuildContextInjectionInput {
  sessionId: string;
  prompt: string;
  usage?: ContextBudgetUsage;
  injectionScopeId?: string;
}

export interface BuildContextInjectionResult {
  text: string;
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}

export interface ContextInjectionOrchestratorDeps {
  cwd: string;
  maxInjectionTokens: number;
  isContextBudgetEnabled(): boolean;
  sanitizeInput(text: string): string;
  getTruthState(sessionId: string): TruthState;
  maybeAlignTaskStatus(input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }): void;
  getLatestOutputHealth(
    sessionId: string,
  ): { score: number; drunk: boolean; flags: string[] } | null;
  selectSkills(message: string): SkillSelection[];
  buildSkillCandidateBlock(selected: SkillSelection[]): string;
  getLedgerDigest(sessionId: string): string;
  getLatestCompactionSummary(sessionId: string): { entryId?: string; summary: string } | undefined;
  getTaskState(sessionId: string): TaskState;
  buildTaskStateBlock(state: TaskState): string;
  recentFiles(sessionId: string, limit: number): string[];
  setViewportPolicy(sessionId: string, policy: ViewportPolicySnapshot): void;
  registerContextInjection(sessionId: string, input: RegisterContextInjectionInput): void;
  getCurrentTurn(sessionId: string): number;
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }): void;
  planContextInjection(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult;
  commitContextInjection(sessionId: string, consumedKeys: string[]): void;
  planBudgetInjection(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
  ): ContextInjectionDecision;
  buildInjectionScopeKey(sessionId: string, injectionScopeId?: string): string;
  getReservedTokens(scopeKey: string): number;
  setReservedTokens(scopeKey: string, tokens: number): void;
  getLastInjectedFingerprint(scopeKey: string): string | undefined;
  setLastInjectedFingerprint(scopeKey: string, fingerprint: string): void;
}

export function buildContextInjection(
  deps: ContextInjectionOrchestratorDeps,
  input: BuildContextInjectionInput,
): BuildContextInjectionResult {
  const promptText = deps.sanitizeInput(input.prompt);
  const truthBlock = buildTruthLedgerBlock({ cwd: deps.cwd });
  if (truthBlock) {
    deps.registerContextInjection(input.sessionId, {
      source: "brewva.truth",
      id: "truth-ledger",
      priority: "critical",
      oncePerSession: true,
      content: truthBlock,
    });
  }

  const truthState = deps.getTruthState(input.sessionId);
  if (truthState.facts.some((fact) => fact.status === "active")) {
    deps.registerContextInjection(input.sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      priority: "critical",
      content: buildTruthFactsBlock({ state: truthState }),
    });
  }
  deps.maybeAlignTaskStatus({
    sessionId: input.sessionId,
    promptText,
    truthState,
    usage: input.usage,
  });

  const outputHealth = deps.getLatestOutputHealth(input.sessionId);
  if (
    outputHealth &&
    (outputHealth.drunk || outputHealth.score < OUTPUT_HEALTH_GUARD_SCORE_THRESHOLD)
  ) {
    deps.registerContextInjection(input.sessionId, {
      source: "brewva.output-guard",
      id: "output-health",
      priority: "high",
      content: buildOutputHealthGuardBlock(outputHealth),
    });
  }

  const selected = deps.selectSkills(promptText);
  deps.registerContextInjection(input.sessionId, {
    source: "brewva.skill-candidates",
    id: "top-k-skills",
    priority: "high",
    content: deps.buildSkillCandidateBlock(selected),
  });
  deps.registerContextInjection(input.sessionId, {
    source: "brewva.ledger-digest",
    id: "ledger-digest",
    priority: "normal",
    content: deps.getLedgerDigest(input.sessionId),
  });

  const latestCompaction = deps.getLatestCompactionSummary(input.sessionId);
  if (latestCompaction?.summary) {
    deps.registerContextInjection(input.sessionId, {
      source: "brewva.compaction-summary",
      id: latestCompaction.entryId ?? "latest",
      priority: "high",
      oncePerSession: true,
      content: `[CompactionSummary]\n${latestCompaction.summary}`,
    });
  }

  const taskState = deps.getTaskState(input.sessionId);
  if (
    taskState.spec ||
    taskState.status ||
    taskState.items.length > 0 ||
    taskState.blockers.length > 0
  ) {
    const taskBlock = deps.buildTaskStateBlock(taskState);
    if (taskBlock) {
      deps.registerContextInjection(input.sessionId, {
        source: "brewva.task-state",
        id: "task-state",
        priority: "critical",
        content: taskBlock,
      });
    }
  }

  const taskSpec = taskState.spec;
  const explicitFiles = taskSpec?.targets?.files ?? [];
  const fallbackFiles = explicitFiles.length === 0 ? deps.recentFiles(input.sessionId, 3) : [];
  const viewportFiles = explicitFiles.length > 0 ? explicitFiles : fallbackFiles;
  const viewportSymbols = taskSpec?.targets?.symbols ?? [];
  if (viewportFiles.length > 0) {
    const viewportPolicy = decideViewportPolicy({
      cwd: deps.cwd,
      sessionId: input.sessionId,
      goal: taskSpec?.goal || promptText,
      targetFiles: viewportFiles,
      targetSymbols: viewportSymbols,
    });

    deps.setViewportPolicy(input.sessionId, {
      quality: viewportPolicy.quality,
      score: viewportPolicy.score,
      variant: viewportPolicy.variant,
      updatedAt: Date.now(),
    });

    if (viewportPolicy.guardBlock) {
      deps.registerContextInjection(input.sessionId, {
        source: "brewva.viewport-policy",
        id: "viewport-policy",
        priority: viewportPolicy.variant === "skipped" ? "critical" : "high",
        content: viewportPolicy.guardBlock,
      });
    }

    if (viewportPolicy.selected.text) {
      deps.recordEvent({
        sessionId: input.sessionId,
        type: "viewport_built",
        turn: deps.getCurrentTurn(input.sessionId),
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
          importsExportsLines: viewportPolicy.selected.metrics.importsExportsLines,
          relevantTotalLines: viewportPolicy.selected.metrics.relevantTotalLines,
          relevantHitLines: viewportPolicy.selected.metrics.relevantHitLines,
          symbolLines: viewportPolicy.selected.metrics.symbolLines,
          neighborhoodLines: viewportPolicy.selected.metrics.neighborhoodLines,
          totalChars: viewportPolicy.selected.metrics.totalChars,
          truncated: viewportPolicy.selected.metrics.truncated,
        },
      });

      if (viewportPolicy.variant !== "skipped") {
        deps.registerContextInjection(input.sessionId, {
          source: "brewva.viewport",
          id: "viewport",
          priority: "high",
          content: viewportPolicy.selected.text,
        });
      }
    }

    if (viewportPolicy.variant !== "full" || viewportPolicy.quality === "low") {
      deps.recordEvent({
        sessionId: input.sessionId,
        type: "viewport_policy_evaluated",
        turn: deps.getCurrentTurn(input.sessionId),
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

  const merged = deps.planContextInjection(
    input.sessionId,
    deps.isContextBudgetEnabled() ? deps.maxInjectionTokens : Number.MAX_SAFE_INTEGER,
  );
  const decision = deps.planBudgetInjection(input.sessionId, merged.text, input.usage);
  const wasTruncated = decision.truncated || merged.truncated;
  if (decision.accepted) {
    const fingerprint = sha256(decision.finalText);
    const scopeKey = deps.buildInjectionScopeKey(input.sessionId, input.injectionScopeId);
    const previous = deps.getLastInjectedFingerprint(scopeKey);
    if (previous === fingerprint) {
      deps.setReservedTokens(scopeKey, 0);
      deps.commitContextInjection(input.sessionId, merged.consumedKeys);
      deps.recordEvent({
        sessionId: input.sessionId,
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

    deps.commitContextInjection(input.sessionId, merged.consumedKeys);
    deps.setReservedTokens(scopeKey, deps.isContextBudgetEnabled() ? decision.finalTokens : 0);
    deps.setLastInjectedFingerprint(scopeKey, fingerprint);
    deps.recordEvent({
      sessionId: input.sessionId,
      type: "context_injected",
      payload: {
        originalTokens: decision.originalTokens,
        finalTokens: decision.finalTokens,
        truncated: wasTruncated,
        usagePercent: input.usage?.percent ?? null,
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

  const rejectedScopeKey = deps.buildInjectionScopeKey(input.sessionId, input.injectionScopeId);
  deps.setReservedTokens(rejectedScopeKey, 0);
  deps.recordEvent({
    sessionId: input.sessionId,
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
