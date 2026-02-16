import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RoasterConfig } from "@pi-roaster/roaster-runtime";
import { DEFAULT_ROASTER_CONFIG, RoasterRuntime } from "@pi-roaster/roaster-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `roaster-${name}-`));
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  return workspace;
}

function writeConfig(workspace: string, config: RoasterConfig): void {
  writeFileSync(join(workspace, ".pi/roaster.json"), JSON.stringify(config, null, 2), "utf8");
}

function createConfig(overrides: Partial<RoasterConfig>): RoasterConfig {
  return {
    ...DEFAULT_ROASTER_CONFIG,
    ...overrides,
    skills: {
      ...DEFAULT_ROASTER_CONFIG.skills,
      ...overrides.skills,
      selector: {
        ...DEFAULT_ROASTER_CONFIG.skills.selector,
        ...overrides.skills?.selector,
      },
    },
    verification: {
      ...DEFAULT_ROASTER_CONFIG.verification,
      ...overrides.verification,
      checks: {
        ...DEFAULT_ROASTER_CONFIG.verification.checks,
        ...overrides.verification?.checks,
      },
      commands: {
        ...DEFAULT_ROASTER_CONFIG.verification.commands,
        ...overrides.verification?.commands,
      },
    },
    ledger: {
      ...DEFAULT_ROASTER_CONFIG.ledger,
      ...overrides.ledger,
    },
    security: {
      ...DEFAULT_ROASTER_CONFIG.security,
      ...overrides.security,
    },
    parallel: {
      ...DEFAULT_ROASTER_CONFIG.parallel,
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

    const runtime = new RoasterRuntime({ cwd: workspace, configPath: ".pi/roaster.json" });
    const sessionId = "verify-blockers-1";

    runtime.markToolCall(sessionId, "edit");

    const report1 = await runtime.verifyCompletion(sessionId, "standard", { executeCommands: true, timeoutMs: 5_000 });
    expect(report1.passed).toBe(false);

    const state1 = runtime.getTaskState(sessionId);
    const blocker1 = state1.blockers.find((blocker) => blocker.id === "verifier:tests");
    expect(blocker1).not.toBeUndefined();
    expect(blocker1?.message.includes("verification failed: tests")).toBe(true);
    expect(blocker1?.message.includes("ledgerId: ev_")).toBe(true);
    expect(blocker1?.message.includes("exitCode:")).toBe(true);

    const injection1 = runtime.buildContextInjection(sessionId, "why failed?");
    expect(injection1.text.includes("[TaskLedger]")).toBe(true);
    expect(injection1.text.includes("verifier:tests")).toBe(true);

    runtime.config.verification.commands.tests = "true";
    runtime.markToolCall(sessionId, "edit");

    const report2 = await runtime.verifyCompletion(sessionId, "standard", { executeCommands: true, timeoutMs: 5_000 });
    expect(report2.passed).toBe(true);

    const state2 = runtime.getTaskState(sessionId);
    expect(state2.blockers.some((blocker) => blocker.id === "verifier:tests")).toBe(false);
  });
});
