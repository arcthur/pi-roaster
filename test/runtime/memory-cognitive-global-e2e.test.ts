import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-memory-e2e-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function createConfig(input?: {
  testsCommand?: string;
  cognitiveMode?: BrewvaConfig["memory"]["cognitive"]["mode"];
}): BrewvaConfig {
  const testsCommand = input?.testsCommand ?? "false";
  const cognitiveMode = input?.cognitiveMode ?? "shadow";

  return {
    ...DEFAULT_BREWVA_CONFIG,
    verification: {
      ...DEFAULT_BREWVA_CONFIG.verification,
      defaultLevel: "standard",
      checks: {
        ...DEFAULT_BREWVA_CONFIG.verification.checks,
        quick: ["type-check"],
        standard: ["type-check", "tests"],
        strict: ["type-check", "tests"],
      },
      commands: {
        ...DEFAULT_BREWVA_CONFIG.verification.commands,
        "type-check": "true",
        tests: testsCommand,
      },
    },
    memory: {
      ...DEFAULT_BREWVA_CONFIG.memory,
      enabled: true,
      cognitive: {
        ...DEFAULT_BREWVA_CONFIG.memory.cognitive,
        mode: cognitiveMode,
        maxTokensPerTurn: 256,
      },
      global: {
        ...DEFAULT_BREWVA_CONFIG.memory.global,
        enabled: true,
        minConfidence: 0.8,
      },
    },
    infrastructure: {
      ...DEFAULT_BREWVA_CONFIG.infrastructure,
      events: {
        ...DEFAULT_BREWVA_CONFIG.infrastructure.events,
        level: "debug",
      },
    },
  };
}

describe("memory cognitive global e2e", () => {
  test("chains verification outcomes, cognitive reflection, global promotion, and pass resolution", async () => {
    const workspace = createWorkspace("chain");
    const cognitivePort = {
      reflectOnOutcome: () => ({
        lesson: "Split verification into fast and slow stages.",
        pattern: "verification:standard:none",
        rootCause: "failed checks: tests",
        recommendation: "run type-check before tests",
        adjustedStrategy: "run type-check first, then run focused tests",
        usage: {
          totalTokens: 8,
        },
      }),
    };

    const runtimeA = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig({ testsCommand: "false", cognitiveMode: "shadow" }),
      cognitivePort,
    });

    const sessionA = "memory-e2e-session-a";
    runtimeA.tools.markCall(sessionA, "edit");
    const failA = await runtimeA.verification.verify(sessionA, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(failA.passed).toBe(false);

    const injectionA = await runtimeA.context.buildInjection(
      sessionA,
      "stabilize verification failures and summarize lessons",
    );
    expect(injectionA.text.includes("[WorkingMemory]")).toBe(true);
    expect(injectionA.text.includes("Lessons Learned")).toBe(true);

    const sessionAHits = await runtimeA.memory.search(sessionA, {
      query: "fast and slow stages",
      limit: 8,
    });
    expect(sessionAHits.hits.length).toBeGreaterThan(0);
    expect(sessionAHits.hits.some((hit) => hit.sourceTier === "session")).toBe(true);

    const sessionAEvents = runtimeA.events.query(sessionA);
    expect(sessionAEvents.some((event) => event.type === "verification_outcome_recorded")).toBe(
      true,
    );
    expect(sessionAEvents.some((event) => event.type === "cognitive_outcome_reflection")).toBe(
      true,
    );

    // Use a fresh runtime instance to avoid lifecycle cooldown and simulate restart/session boundary.
    const runtimeB = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig({ testsCommand: "false", cognitiveMode: "shadow" }),
      cognitivePort,
    });

    const sessionB = "memory-e2e-session-b";
    runtimeB.tools.markCall(sessionB, "edit");
    const failB = await runtimeB.verification.verify(sessionB, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(failB.passed).toBe(false);

    await runtimeB.context.buildInjection(
      sessionB,
      "stabilize verification failures and summarize lessons",
    );

    const sessionBSync = runtimeB.events.query(sessionB, { type: "memory_global_sync" });
    expect(sessionBSync.some((event) => Number(event.payload?.promoted ?? 0) > 0)).toBe(true);

    const runtimeRead = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig({ testsCommand: "false", cognitiveMode: "shadow" }),
      cognitivePort,
    });
    const readSession = "memory-e2e-session-read";

    const globalHitsBeforePass = await runtimeRead.memory.search(readSession, {
      query: "verification:standard:none failed checks tests",
      limit: 12,
    });
    expect(globalHitsBeforePass.hits.some((hit) => hit.sourceTier === "global")).toBe(true);

    const globalFacetHit = globalHitsBeforePass.hits.find(
      (hit) =>
        hit.sourceTier === "global" &&
        hit.knowledgeFacets?.pattern === "verification:standard:none" &&
        (hit.knowledgeFacets?.outcomes.fail ?? 0) > 0,
    );
    expect(globalFacetHit).toBeDefined();

    const recallBeforePass = await runtimeRead.context.buildInjection(
      readSession,
      "verification:standard:none failed checks tests lessons",
    );
    expect(recallBeforePass.text.includes("[MemoryRecall]")).toBe(true);
    expect(recallBeforePass.text.includes("facets: pattern=verification:standard:none")).toBe(true);

    const runtimePass = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig({ testsCommand: "true", cognitiveMode: "shadow" }),
      cognitivePort,
    });

    const passSession = "memory-e2e-session-pass";
    runtimePass.tools.markCall(passSession, "edit");
    const passReport = await runtimePass.verification.verify(passSession, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(passReport.passed).toBe(true);

    await runtimePass.context.buildInjection(passSession, "verification pass reconciliation");

    const passSync = runtimePass.events.query(passSession, { type: "memory_global_sync" });
    expect(passSync.some((event) => Number(event.payload?.resolvedByPass ?? 0) > 0)).toBe(true);

    const runtimeAfterPass = new BrewvaRuntime({
      cwd: workspace,
      config: createConfig({ testsCommand: "false", cognitiveMode: "shadow" }),
      cognitivePort,
    });

    const afterPassHits = await runtimeAfterPass.memory.search("memory-e2e-session-after-pass", {
      query: "verification failed failed checks tests",
      limit: 12,
    });

    const leakedGlobalFailUnits = afterPassHits.hits.some(
      (hit) =>
        hit.sourceTier === "global" &&
        hit.kind === "unit" &&
        hit.excerpt.toLowerCase().includes("verification failed"),
    );
    expect(leakedGlobalFailUnits).toBe(false);

    const hasGlobalPassUnit = afterPassHits.hits.some(
      (hit) =>
        hit.sourceTier === "global" &&
        hit.kind === "unit" &&
        hit.excerpt.toLowerCase().includes("verification passed"),
    );
    expect(hasGlobalPassUnit).toBe(true);
  });
});
