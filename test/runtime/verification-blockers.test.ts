import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestConfig } from "../fixtures/config.js";
import { createTestWorkspace, writeTestConfig } from "../helpers/workspace.js";

function createWorkspace(name: string): string {
  return createTestWorkspace(name);
}

function writeConfig(
  workspace: string,
  config: import("@brewva/brewva-runtime").BrewvaConfig,
): void {
  writeTestConfig(workspace, config);
}

describe("Verification blockers", () => {
  test("given failing checks then pass, when verification runs, then blocker is created and resolved", async () => {
    const workspace = createWorkspace("verification-blockers");
    writeConfig(
      workspace,
      createTestConfig(
        {
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
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "verify-blockers-1";

    runtime.tools.markCall(sessionId, "edit");

    const report1 = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report1.passed).toBe(false);
    const failOutcomes = runtime.events.query(sessionId, { type: "verification_outcome_recorded" });
    expect(failOutcomes.length).toBeGreaterThanOrEqual(1);
    expect(failOutcomes.at(-1)?.payload?.outcome).toBe("fail");
    expect(typeof failOutcomes.at(-1)?.payload?.lessonKey).toBe("string");
    expect(typeof failOutcomes.at(-1)?.payload?.pattern).toBe("string");
    expect(typeof failOutcomes.at(-1)?.payload?.rootCause).toBe("string");
    expect(typeof failOutcomes.at(-1)?.payload?.recommendation).toBe("string");

    const state1 = runtime.task.getState(sessionId);
    const blocker1 = state1.blockers.find((blocker) => blocker.id === "verifier:tests");
    expect(blocker1).not.toBeUndefined();
    expect(blocker1?.message.includes("verification failed: tests")).toBe(true);
    expect(blocker1?.message.includes("truth=truth:verifier:tests")).toBe(true);
    expect(blocker1?.message.includes("evidence=ev_")).toBe(true);
    expect(blocker1?.message.includes("exitCode=")).toBe(true);
    expect(blocker1?.truthFactId).toBe("truth:verifier:tests");

    const truth1 = runtime.truth.getState(sessionId);
    const truthFact1 = truth1.facts.find((fact) => fact.id === "truth:verifier:tests");
    expect(truthFact1).not.toBeUndefined();
    expect(truthFact1?.status).toBe("active");

    const injection1 = await runtime.context.buildInjection(sessionId, "why failed?");
    expect(injection1.text.includes("[TaskLedger]")).toBe(true);
    expect(injection1.text.includes("verifier:tests")).toBe(true);

    runtime.config.verification.commands.tests = "true";
    runtime.tools.markCall(sessionId, "edit");

    const report2 = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report2.passed).toBe(true);
    const allOutcomes = runtime.events.query(sessionId, { type: "verification_outcome_recorded" });
    expect(allOutcomes.length).toBeGreaterThanOrEqual(2);
    expect(allOutcomes.at(-1)?.payload?.outcome).toBe("pass");

    const state2 = runtime.task.getState(sessionId);
    expect(state2.blockers.some((blocker) => blocker.id === "verifier:tests")).toBe(false);

    const truth2 = runtime.truth.getState(sessionId);
    const truthFact2 = truth2.facts.find((fact) => fact.id === "truth:verifier:tests");
    expect(truthFact2).not.toBeUndefined();
    expect(truthFact2?.status).toBe("resolved");
  });

  test("given shadow cognitive mode, when verification fails, then cognitive reflection is recorded", async () => {
    const workspace = createWorkspace("verification-reflection");
    writeConfig(
      workspace,
      createTestConfig(
        {
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
              maxTokensPerTurn: 128,
            },
          },
        },
        { eventsLevel: "debug" },
      ),
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
    runtime.tools.markCall(sessionId, "edit");

    const report = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(false);

    const reflectionEvents = runtime.events.query(sessionId, {
      type: "cognitive_outcome_reflection",
    });
    expect(reflectionEvents).toHaveLength(1);
    expect(reflectionEvents[0]?.payload?.lesson).toBe(
      "Split verification into fast and slow stages.",
    );
    expect(typeof reflectionEvents[0]?.payload?.pattern).toBe("string");
    expect(typeof reflectionEvents[0]?.payload?.recommendation).toBe("string");

    const memoryHits = await runtime.memory.search(sessionId, {
      query: "fast and slow stages",
      limit: 5,
    });
    expect(memoryHits.hits.length).toBeGreaterThan(0);
  });

  test("given cognitive mode off, when verification fails, then reflection is skipped", async () => {
    const workspace = createWorkspace("verification-reflection-limit");
    writeConfig(
      workspace,
      createTestConfig(
        {
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
              mode: "off",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      cognitivePort: {
        reflectOnOutcome: () => ({
          lesson: "Should not be emitted when reflection limit is zero.",
        }),
      },
    });
    const sessionId = "verify-reflection-limit-1";
    runtime.tools.markCall(sessionId, "edit");

    const report = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(false);

    const reflections = runtime.events.query(sessionId, { type: "cognitive_outcome_reflection" });
    expect(reflections).toHaveLength(0);
    const skipped = runtime.events.query(sessionId, {
      type: "cognitive_outcome_reflection_skipped",
    });
    expect(skipped.length).toBe(0);
  });

  test("given exhausted cognitive token budget, when verification fails, then reflection is skipped", async () => {
    const workspace = createWorkspace("verification-reflection-token-budget");
    writeConfig(
      workspace,
      createTestConfig(
        {
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
        },
        { eventsLevel: "debug" },
      ),
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
    runtime.tools.markCall(sessionId, "edit");

    const first = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(first.passed).toBe(false);

    const second = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(second.passed).toBe(false);

    const reflectionEvents = runtime.events.query(sessionId, {
      type: "cognitive_outcome_reflection",
    });
    expect(reflectionEvents).toHaveLength(1);
    const skipped = runtime.events.query(sessionId, {
      type: "cognitive_outcome_reflection_skipped",
    });
    expect(skipped.some((event) => event.payload?.reason === "token_budget_exhausted")).toBe(true);
  });

  test("given no prior write evidence, when verification runs, then outcome is still recorded", async () => {
    const workspace = createWorkspace("verification-outcome-without-write");
    writeConfig(
      workspace,
      createTestConfig(
        {
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
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "verify-outcome-no-write";
    const report = await runtime.verification.verify(sessionId, "quick", {
      executeCommands: false,
    });
    expect(report.passed).toBe(true);

    const outcomes = runtime.events.query(sessionId, { type: "verification_outcome_recorded" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload?.outcome).toBe("pass");
    expect(typeof outcomes[0]?.payload?.lessonKey).toBe("string");
  });
});
