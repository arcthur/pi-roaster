import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { ContextBudgetManager } from "../../packages/brewva-runtime/src/context/budget.js";
import {
  commitSupplementalContextInjection,
  planSupplementalContextInjection,
  type ContextSupplementalBudgetDeps,
} from "../../packages/brewva-runtime/src/services/context-supplemental-budget.js";
import { RuntimeSessionStateStore } from "../../packages/brewva-runtime/src/services/session-state.js";

describe("context-supplemental-budget module", () => {
  test("truncates supplemental injection by remaining per-scope budget", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.maxInjectionTokens = 24;

    const sessionState = new RuntimeSessionStateStore();
    sessionState.setReservedInjectionTokens("supplemental::root", 20);

    const deps: ContextSupplementalBudgetDeps = {
      config,
      contextBudget: new ContextBudgetManager(config.infrastructure.contextBudget),
      sessionState,
    };

    const result = planSupplementalContextInjection(
      deps,
      "supplemental",
      "one two three four five six seven eight nine ten eleven twelve",
    );
    expect(result.accepted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(4);
  });

  test("returns budget_exhausted when no supplemental scope budget remains", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.maxInjectionTokens = 12;

    const sessionState = new RuntimeSessionStateStore();
    sessionState.setReservedInjectionTokens("supplemental::root", 12);

    const deps: ContextSupplementalBudgetDeps = {
      config,
      contextBudget: new ContextBudgetManager(config.infrastructure.contextBudget),
      sessionState,
    };

    const result = planSupplementalContextInjection(deps, "supplemental", "any supplemental text");
    expect(result.accepted).toBe(false);
    expect(result.droppedReason).toBe("budget_exhausted");
  });

  test("commit clamps reserved supplemental tokens to maxInjectionTokens", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.contextBudget.enabled = true;
    config.infrastructure.contextBudget.maxInjectionTokens = 10;

    const sessionState = new RuntimeSessionStateStore();
    sessionState.setReservedInjectionTokens("supplemental::root", 8);

    const deps: ContextSupplementalBudgetDeps = {
      config,
      contextBudget: new ContextBudgetManager(config.infrastructure.contextBudget),
      sessionState,
    };

    commitSupplementalContextInjection(deps, "supplemental", 5);
    expect(sessionState.getReservedInjectionTokens("supplemental::root")).toBe(10);
  });
});
