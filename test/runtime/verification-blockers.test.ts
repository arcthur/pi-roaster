import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function writeConfig(workspace: string, config: BrewvaConfig): void {
  writeFileSync(join(workspace, ".brewva/brewva.json"), JSON.stringify(config, null, 2), "utf8");
}

function createConfig(overrides: Partial<BrewvaConfig>): BrewvaConfig {
  return {
    ...DEFAULT_BREWVA_CONFIG,
    ...overrides,
    skills: {
      ...DEFAULT_BREWVA_CONFIG.skills,
      ...overrides.skills,
      selector: {
        ...DEFAULT_BREWVA_CONFIG.skills.selector,
        ...overrides.skills?.selector,
      },
    },
    verification: {
      ...DEFAULT_BREWVA_CONFIG.verification,
      ...overrides.verification,
      checks: {
        ...DEFAULT_BREWVA_CONFIG.verification.checks,
        ...overrides.verification?.checks,
      },
      commands: {
        ...DEFAULT_BREWVA_CONFIG.verification.commands,
        ...overrides.verification?.commands,
      },
    },
    ledger: {
      ...DEFAULT_BREWVA_CONFIG.ledger,
      ...overrides.ledger,
    },
    security: {
      ...DEFAULT_BREWVA_CONFIG.security,
      ...overrides.security,
    },
    parallel: {
      ...DEFAULT_BREWVA_CONFIG.parallel,
      ...overrides.parallel,
    },
  };
}

describe("Verification blockers", () => {
  test("syncs failing checks into Task Ledger blockers and resolves on pass", async () => {
    const workspace = createWorkspace("verification-blockers");
    writeConfig(
      workspace,
      createConfig({
        verification: {
          defaultLevel: "standard",
          checks: {
            quick: ["type-check"],
            standard: ["type-check", "tests"],
            strict: ["type-check", "tests"],
          },
          commands: {
            "type-check": "true",
            tests: "false",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "verify-blockers-1";

    runtime.markToolCall(sessionId, "edit");

    const report1 = await runtime.verifyCompletion(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report1.passed).toBe(false);
    const failOutcomes = runtime.queryEvents(sessionId, { type: "verification_outcome_recorded" });
    expect(failOutcomes.length).toBeGreaterThanOrEqual(1);
    expect(failOutcomes.at(-1)?.payload?.outcome).toBe("fail");
    expect(typeof failOutcomes.at(-1)?.payload?.lessonKey).toBe("string");
    expect(typeof failOutcomes.at(-1)?.payload?.pattern).toBe("string");
    expect(typeof failOutcomes.at(-1)?.payload?.rootCause).toBe("string");
    expect(typeof failOutcomes.at(-1)?.payload?.recommendation).toBe("string");

    const state1 = runtime.getTaskState(sessionId);
    const blocker1 = state1.blockers.find((blocker) => blocker.id === "verifier:tests");
    expect(blocker1).not.toBeUndefined();
    expect(blocker1?.message.includes("verification failed: tests")).toBe(true);
    expect(blocker1?.message.includes("truth=truth:verifier:tests")).toBe(true);
    expect(blocker1?.message.includes("evidence=ev_")).toBe(true);
    expect(blocker1?.message.includes("exitCode=")).toBe(true);
    expect(blocker1?.truthFactId).toBe("truth:verifier:tests");

    const truth1 = runtime.getTruthState(sessionId);
    const truthFact1 = truth1.facts.find((fact) => fact.id === "truth:verifier:tests");
    expect(truthFact1).not.toBeUndefined();
    expect(truthFact1?.status).toBe("active");

    const injection1 = runtime.buildContextInjection(sessionId, "why failed?");
    expect(injection1.text.includes("[TaskLedger]")).toBe(true);
    expect(injection1.text.includes("verifier:tests")).toBe(true);

    runtime.config.verification.commands.tests = "true";
    runtime.markToolCall(sessionId, "edit");

    const report2 = await runtime.verifyCompletion(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report2.passed).toBe(true);
    const allOutcomes = runtime.queryEvents(sessionId, { type: "verification_outcome_recorded" });
    expect(allOutcomes.length).toBeGreaterThanOrEqual(2);
    expect(allOutcomes.at(-1)?.payload?.outcome).toBe("pass");

    const state2 = runtime.getTaskState(sessionId);
    expect(state2.blockers.some((blocker) => blocker.id === "verifier:tests")).toBe(false);

    const truth2 = runtime.getTruthState(sessionId);
    const truthFact2 = truth2.facts.find((fact) => fact.id === "truth:verifier:tests");
    expect(truthFact2).not.toBeUndefined();
    expect(truthFact2?.status).toBe("resolved");
  });

  test("records cognitive outcome reflection when shadow mode is enabled", async () => {
    const workspace = createWorkspace("verification-reflection");
    writeConfig(
      workspace,
      createConfig({
        verification: {
          defaultLevel: "standard",
          checks: {
            quick: ["type-check"],
            standard: ["type-check", "tests"],
            strict: ["type-check", "tests"],
          },
          commands: {
            "type-check": "true",
            tests: "false",
          },
        },
        memory: {
          ...DEFAULT_BREWVA_CONFIG.memory,
          cognitive: {
            ...DEFAULT_BREWVA_CONFIG.memory.cognitive,
            mode: "shadow",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      cognitivePort: {
        reflectOnOutcome: () => ({
          lesson: "Split verification into fast and slow stages.",
          adjustedStrategy: "Run type-check first, then focused tests.",
        }),
      },
    });
    const sessionId = "verify-reflection-1";
    runtime.markToolCall(sessionId, "edit");

    const report = await runtime.verifyCompletion(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(false);

    const reflectionEvents = runtime.queryEvents(sessionId, {
      type: "cognitive_outcome_reflection",
    });
    expect(reflectionEvents).toHaveLength(1);
    expect(reflectionEvents[0]?.payload?.lesson).toBe(
      "Split verification into fast and slow stages.",
    );
    expect(typeof reflectionEvents[0]?.payload?.pattern).toBe("string");
    expect(typeof reflectionEvents[0]?.payload?.recommendation).toBe("string");

    const memoryHits = runtime.searchMemory(sessionId, {
      query: "fast and slow stages",
      limit: 5,
    });
    expect(memoryHits.hits.length).toBeGreaterThan(0);
  });

  test("skips cognitive reflection when cognitive token budget is exhausted", async () => {
    const workspace = createWorkspace("verification-reflection-token-budget");
    writeConfig(
      workspace,
      createConfig({
        verification: {
          defaultLevel: "standard",
          checks: {
            quick: ["type-check"],
            standard: ["type-check", "tests"],
            strict: ["type-check", "tests"],
          },
          commands: {
            "type-check": "true",
            tests: "false",
          },
        },
        memory: {
          ...DEFAULT_BREWVA_CONFIG.memory,
          cognitive: {
            ...DEFAULT_BREWVA_CONFIG.memory.cognitive,
            mode: "shadow",
            maxTokensPerTurn: 10,
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      cognitivePort: {
        reflectOnOutcome: () => ({
          lesson: "Use staged verification with focused retries.",
          usage: {
            totalTokens: 12,
          },
        }),
      },
    });
    const sessionId = "verify-reflection-budget-1";
    runtime.markToolCall(sessionId, "edit");

    const first = await runtime.verifyCompletion(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(first.passed).toBe(false);

    const second = await runtime.verifyCompletion(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(second.passed).toBe(false);

    const reflectionEvents = runtime.queryEvents(sessionId, {
      type: "cognitive_outcome_reflection",
    });
    expect(reflectionEvents).toHaveLength(1);
    const skipped = runtime.queryEvents(sessionId, {
      type: "cognitive_outcome_reflection_skipped",
    });
    expect(skipped.some((event) => event.payload?.reason === "token_budget_exhausted")).toBe(true);
  });

  test("records verification outcome even when no prior write evidence exists", async () => {
    const workspace = createWorkspace("verification-outcome-without-write");
    writeConfig(
      workspace,
      createConfig({
        verification: {
          defaultLevel: "quick",
          checks: {
            quick: ["type-check"],
            standard: ["type-check"],
            strict: ["type-check"],
          },
          commands: {
            "type-check": "true",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "verify-outcome-no-write";
    const report = await runtime.verifyCompletion(sessionId, "quick", {
      executeCommands: false,
    });
    expect(report.passed).toBe(true);

    const outcomes = runtime.queryEvents(sessionId, { type: "verification_outcome_recorded" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload?.outcome).toBe("pass");
    expect(typeof outcomes[0]?.payload?.lessonKey).toBe("string");
  });
});
