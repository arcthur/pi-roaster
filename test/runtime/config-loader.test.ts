import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_ROASTER_CONFIG, loadRoasterConfig } from "@pi-roaster/roaster-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `roaster-config-${name}-`));
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  return workspace;
}

describe("Roaster config loader normalization", () => {
  test("normalizes malformed values and preserves hierarchy invariants", () => {
    const workspace = createWorkspace("normalize");
    const rawConfig = {
      infrastructure: {
        contextBudget: {
          maxInjectionTokens: -100,
          hardLimitPercent: 1.6,
          compactionThresholdPercent: 1.8,
          minTurnsBetweenCompaction: -5,
          minSecondsBetweenCompaction: -10,
          pressureBypassPercent: -0.3,
          truncationStrategy: "invalid_strategy",
          compactionCircuitBreaker: {
            enabled: "yes",
            maxConsecutiveFailures: 0,
            cooldownTurns: 0,
          },
        },
        interruptRecovery: {
          gracefulTimeoutMs: -1,
          resumeHintInjectionEnabled: "disabled",
          sessionHandoff: {
            maxSummaryChars: 0,
            hierarchy: {
              entriesPerLevel: 1,
              branchFactor: 99,
              minGoalScore: 2,
              maxInjectedEntries: 0,
            },
            injectionBudget: {
              maxTotalChars: 0,
              maxHierarchyChars: -1,
            },
            circuitBreaker: {
              maxConsecutiveFailures: 0,
              cooldownTurns: -3,
            },
          },
        },
        costTracking: {
          alertThresholdRatio: 2,
          actionOnExceed: "drop_session",
        },
      },
    };
    writeFileSync(join(workspace, ".pi/roaster.json"), JSON.stringify(rawConfig, null, 2), "utf8");

    const loaded = loadRoasterConfig({ cwd: workspace, configPath: ".pi/roaster.json" });
    const defaults = DEFAULT_ROASTER_CONFIG;

    expect(loaded.infrastructure.contextBudget.maxInjectionTokens).toBe(defaults.infrastructure.contextBudget.maxInjectionTokens);
    expect(loaded.infrastructure.contextBudget.hardLimitPercent).toBe(1);
    expect(loaded.infrastructure.contextBudget.compactionThresholdPercent).toBeLessThanOrEqual(
      loaded.infrastructure.contextBudget.hardLimitPercent,
    );
    expect(loaded.infrastructure.contextBudget.minTurnsBetweenCompaction).toBe(0);
    expect(loaded.infrastructure.contextBudget.minSecondsBetweenCompaction).toBe(0);
    expect(loaded.infrastructure.contextBudget.pressureBypassPercent).toBe(0);
    expect(loaded.infrastructure.contextBudget.truncationStrategy).toBe(defaults.infrastructure.contextBudget.truncationStrategy);
    expect(loaded.infrastructure.contextBudget.compactionCircuitBreaker.enabled).toBe(
      defaults.infrastructure.contextBudget.compactionCircuitBreaker.enabled,
    );
    expect(loaded.infrastructure.contextBudget.compactionCircuitBreaker.maxConsecutiveFailures).toBe(
      defaults.infrastructure.contextBudget.compactionCircuitBreaker.maxConsecutiveFailures,
    );
    expect(loaded.infrastructure.contextBudget.compactionCircuitBreaker.cooldownTurns).toBe(
      defaults.infrastructure.contextBudget.compactionCircuitBreaker.cooldownTurns,
    );

    expect(loaded.infrastructure.interruptRecovery.gracefulTimeoutMs).toBe(
      defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
    );
    expect(loaded.infrastructure.interruptRecovery.resumeHintInjectionEnabled).toBe(
      defaults.infrastructure.interruptRecovery.resumeHintInjectionEnabled,
    );
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.maxSummaryChars).toBe(
      defaults.infrastructure.interruptRecovery.sessionHandoff.maxSummaryChars,
    );
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.hierarchy.entriesPerLevel).toBe(2);
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.hierarchy.branchFactor).toBe(2);
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.hierarchy.minGoalScore).toBe(1);
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.hierarchy.maxInjectedEntries).toBe(
      defaults.infrastructure.interruptRecovery.sessionHandoff.hierarchy.maxInjectedEntries,
    );
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxTotalChars).toBe(
      defaults.infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxTotalChars,
    );
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxHierarchyChars).toBe(
      defaults.infrastructure.interruptRecovery.sessionHandoff.injectionBudget.maxHierarchyChars,
    );
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.circuitBreaker.maxConsecutiveFailures).toBe(
      defaults.infrastructure.interruptRecovery.sessionHandoff.circuitBreaker.maxConsecutiveFailures,
    );
    expect(loaded.infrastructure.interruptRecovery.sessionHandoff.circuitBreaker.cooldownTurns).toBe(
      defaults.infrastructure.interruptRecovery.sessionHandoff.circuitBreaker.cooldownTurns,
    );

    expect(loaded.infrastructure.costTracking.alertThresholdRatio).toBe(1);
    expect(loaded.infrastructure.costTracking.actionOnExceed).toBe(defaults.infrastructure.costTracking.actionOnExceed);
  });

  test("returns isolated config instances when no config file exists", () => {
    const workspace = createWorkspace("isolation");

    const first = loadRoasterConfig({ cwd: workspace, configPath: ".pi/roaster.json" });
    first.security.enforceDeniedTools = false;

    const second = loadRoasterConfig({ cwd: workspace, configPath: ".pi/roaster.json" });
    expect(second.security.enforceDeniedTools).toBe(DEFAULT_ROASTER_CONFIG.security.enforceDeniedTools);
  });

  test("maps legacy resumeHintInSystemPrompt into resumeHintInjectionEnabled", () => {
    const workspace = createWorkspace("legacy");
    const rawConfig = {
      infrastructure: {
        interruptRecovery: {
          resumeHintInSystemPrompt: false,
        },
      },
    };
    writeFileSync(join(workspace, ".pi/roaster.json"), JSON.stringify(rawConfig, null, 2), "utf8");

    const loaded = loadRoasterConfig({ cwd: workspace, configPath: ".pi/roaster.json" });
    expect(loaded.infrastructure.interruptRecovery.resumeHintInjectionEnabled).toBe(false);
  });

  test("normalizes skills roots arrays and selector values", () => {
    const workspace = createWorkspace("skills-normalize");
    const rawConfig = {
      skills: {
        roots: ["  ./skills-extra  ", "", 123, null],
        packs: ["  typescript  ", "", null],
        disabled: ["  review  ", "", null],
        selector: {
          k: 0,
          maxDigestTokens: -1,
        },
      },
    };
    writeFileSync(join(workspace, ".pi/roaster.json"), JSON.stringify(rawConfig, null, 2), "utf8");

    const loaded = loadRoasterConfig({ cwd: workspace, configPath: ".pi/roaster.json" });
    expect(loaded.skills.roots).toEqual(["./skills-extra"]);
    expect(loaded.skills.packs).toEqual(["typescript"]);
    expect(loaded.skills.disabled).toEqual(["review"]);
    expect(loaded.skills.selector.k).toBe(DEFAULT_ROASTER_CONFIG.skills.selector.k);
    expect(loaded.skills.selector.maxDigestTokens).toBe(DEFAULT_ROASTER_CONFIG.skills.selector.maxDigestTokens);
  });
});
