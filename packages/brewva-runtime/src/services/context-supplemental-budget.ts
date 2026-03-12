import type { ContextBudgetManager } from "../context/budget.js";
import type { BrewvaConfig, ContextBudgetUsage } from "../types.js";
import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import type { RuntimeSessionStateStore } from "./session-state.js";

export interface SupplementalContextInjectionPlanResult {
  accepted: boolean;
  text: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  droppedReason?: "hard_limit" | "budget_exhausted";
}

export interface ContextSupplementalBudgetDeps {
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  sessionState: RuntimeSessionStateStore;
}

export function planSupplementalContextInjection(
  deps: ContextSupplementalBudgetDeps,
  sessionId: string,
  inputText: string,
  usage?: ContextBudgetUsage,
  injectionScopeId?: string,
): SupplementalContextInjectionPlanResult {
  const decision = deps.contextBudget.planInjection(sessionId, inputText, usage);
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

  if (!deps.config.infrastructure.contextBudget.enabled) {
    return {
      accepted: true,
      text: decision.finalText,
      originalTokens: decision.originalTokens,
      finalTokens: decision.finalTokens,
      truncated: decision.truncated,
    };
  }

  const scopeKey = deps.sessionState.buildInjectionScopeKey(sessionId, injectionScopeId);
  const usedTokens = deps.sessionState.getReservedInjectionTokens(scopeKey) ?? 0;
  const maxTokens = Math.max(
    0,
    Math.floor(deps.config.infrastructure.contextBudget.maxInjectionTokens),
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

export function commitSupplementalContextInjection(
  deps: ContextSupplementalBudgetDeps,
  sessionId: string,
  finalTokens: number,
  injectionScopeId?: string,
): void {
  if (!deps.config.infrastructure.contextBudget.enabled) {
    return;
  }

  const normalizedTokens = Math.max(0, Math.floor(finalTokens));
  if (normalizedTokens <= 0) return;

  const scopeKey = deps.sessionState.buildInjectionScopeKey(sessionId, injectionScopeId);
  const usedTokens = deps.sessionState.getReservedInjectionTokens(scopeKey) ?? 0;
  const maxTokens = Math.max(
    0,
    Math.floor(deps.config.infrastructure.contextBudget.maxInjectionTokens),
  );
  deps.sessionState.setReservedInjectionTokens(
    scopeKey,
    Math.min(maxTokens, usedTokens + normalizedTokens),
  );
}
