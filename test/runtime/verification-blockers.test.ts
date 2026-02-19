import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
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

    const report1 = await runtime.verifyCompletion(sessionId, "standard", { executeCommands: true, timeoutMs: 5_000 });
    expect(report1.passed).toBe(false);

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

    const report2 = await runtime.verifyCompletion(sessionId, "standard", { executeCommands: true, timeoutMs: 5_000 });
    expect(report2.passed).toBe(true);

    const state2 = runtime.getTaskState(sessionId);
    expect(state2.blockers.some((blocker) => blocker.id === "verifier:tests")).toBe(false);

    const truth2 = runtime.getTruthState(sessionId);
    const truthFact2 = truth2.facts.find((fact) => fact.id === "truth:verifier:tests");
    expect(truthFact2).not.toBeUndefined();
    expect(truthFact2?.status).toBe("resolved");
  });
});
