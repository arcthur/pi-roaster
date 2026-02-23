import type {
  ContextBudgetUsage,
  ContextInjectionDecision,
  TaskState,
  TruthState,
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import type { ContextInjectionPlanResult, RegisterContextInjectionInput } from "./injection.js";
import { buildRecentToolFailuresBlock, type ToolFailureEntry } from "./tool-failures.js";
import { buildTruthFactsBlock } from "./truth-facts.js";
import { buildTruthLedgerBlock } from "./truth.js";

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
  getToolFailureInjectionConfig(): {
    enabled: boolean;
    maxEntries: number;
    maxOutputChars: number;
  };
  sanitizeInput(text: string): string;
  getTruthState(sessionId: string): TruthState;
  maybeAlignTaskStatus(input: {
    sessionId: string;
    promptText: string;
    truthState: TruthState;
    usage?: ContextBudgetUsage;
  }): void;
  getRecentToolFailures(sessionId: string): ToolFailureEntry[];
  getTaskState(sessionId: string): TaskState;
  buildTaskStateBlock(state: TaskState): string;
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
  const truthLedgerBlock = buildTruthLedgerBlock({ cwd: deps.cwd });
  const truthState = deps.getTruthState(input.sessionId);
  const truthFactsBlock = truthState.facts.some((fact) => fact.status === "active")
    ? buildTruthFactsBlock({ state: truthState })
    : "";
  const truthBlock = [truthLedgerBlock, truthFactsBlock].filter(Boolean).join("\n\n").trim();
  if (truthBlock) {
    deps.registerContextInjection(input.sessionId, {
      source: "brewva.truth",
      id: "truth",
      priority: "critical",
      oncePerSession: true,
      content: truthBlock,
    });
  }
  deps.maybeAlignTaskStatus({
    sessionId: input.sessionId,
    promptText,
    truthState,
    usage: input.usage,
  });

  const toolFailureConfig = deps.getToolFailureInjectionConfig();
  if (toolFailureConfig.enabled) {
    const recentFailures = deps.getRecentToolFailures(input.sessionId);
    const failureBlock = buildRecentToolFailuresBlock(recentFailures, {
      maxEntries: toolFailureConfig.maxEntries,
      maxOutputChars: toolFailureConfig.maxOutputChars,
    });
    if (failureBlock) {
      deps.registerContextInjection(input.sessionId, {
        source: "brewva.tool-failures",
        id: "recent-failures",
        priority: "high",
        content: failureBlock,
      });
    }
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
