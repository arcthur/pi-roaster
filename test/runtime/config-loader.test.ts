import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BREWVA_CONFIG,
  loadBrewvaConfig,
  resolveGlobalBrewvaConfigPath,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-config-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Brewva config loader normalization", () => {
  test("normalizes malformed values and preserves hierarchy invariants", () => {
    const workspace = createWorkspace("normalize");
    const rawConfig = {
      tape: {
        checkpointIntervalEntries: -9,
        tapePressureThresholds: {
          low: 20,
          medium: 10,
          high: -5,
        },
      },
      infrastructure: {
        contextBudget: {
          maxInjectionTokens: -100,
          hardLimitPercent: 1.6,
          compactionThresholdPercent: 1.8,
          minTurnsBetweenCompaction: -5,
          minSecondsBetweenCompaction: -10,
          pressureBypassPercent: -0.3,
          truncationStrategy: "invalid_strategy",
        },
        interruptRecovery: {
          gracefulTimeoutMs: -1,
        },
        costTracking: {
          alertThresholdRatio: 2,
          actionOnExceed: "drop_session",
        },
      },
    };
    writeFileSync(join(workspace, ".brewva/brewva.json"), JSON.stringify(rawConfig, null, 2), "utf8");

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const defaults = DEFAULT_BREWVA_CONFIG;

    expect(loaded.tape.checkpointIntervalEntries).toBe(0);
    expect(loaded.tape.tapePressureThresholds.low).toBe(20);
    expect(loaded.tape.tapePressureThresholds.medium).toBe(20);
    expect(loaded.tape.tapePressureThresholds.high).toBe(
      defaults.tape.tapePressureThresholds.high,
    );

    expect(loaded.infrastructure.contextBudget.maxInjectionTokens).toBe(defaults.infrastructure.contextBudget.maxInjectionTokens);
    expect(loaded.infrastructure.contextBudget.hardLimitPercent).toBe(1);
    expect(loaded.infrastructure.contextBudget.compactionThresholdPercent).toBeLessThanOrEqual(
      loaded.infrastructure.contextBudget.hardLimitPercent,
    );
    expect(loaded.infrastructure.contextBudget.minTurnsBetweenCompaction).toBe(0);
    expect(loaded.infrastructure.contextBudget.minSecondsBetweenCompaction).toBe(0);
    expect(loaded.infrastructure.contextBudget.pressureBypassPercent).toBe(0);
    expect(loaded.infrastructure.contextBudget.truncationStrategy).toBe(defaults.infrastructure.contextBudget.truncationStrategy);

    expect(loaded.infrastructure.interruptRecovery.gracefulTimeoutMs).toBe(
      defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
    );

    expect(loaded.infrastructure.costTracking.alertThresholdRatio).toBe(1);
    expect(loaded.infrastructure.costTracking.actionOnExceed).toBe(defaults.infrastructure.costTracking.actionOnExceed);
  });

  test("returns isolated config instances when no config file exists", () => {
    const workspace = createWorkspace("isolation");

    const first = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    first.security.enforceDeniedTools = false;

    const second = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(second.security.enforceDeniedTools).toBe(DEFAULT_BREWVA_CONFIG.security.enforceDeniedTools);
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
    writeFileSync(join(workspace, ".brewva/brewva.json"), JSON.stringify(rawConfig, null, 2), "utf8");

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.skills.roots).toEqual([join(workspace, ".brewva/skills-extra")]);
    expect(loaded.skills.packs).toEqual(["typescript"]);
    expect(loaded.skills.disabled).toEqual(["review"]);
    expect(loaded.skills.selector.k).toBe(DEFAULT_BREWVA_CONFIG.skills.selector.k);
    expect(loaded.skills.selector.maxDigestTokens).toBe(DEFAULT_BREWVA_CONFIG.skills.selector.maxDigestTokens);
  });

  test("loads global and project configs with project override precedence", () => {
    const workspace = createWorkspace("layered-default");
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-config-xdg-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgRoot;

    try {
      mkdirSync(join(xdgRoot, "brewva"), { recursive: true });
      writeFileSync(
        resolveGlobalBrewvaConfigPath(process.env),
        JSON.stringify(
          {
            parallel: { maxConcurrent: 7 },
            verification: { defaultLevel: "quick" },
          },
          null,
          2,
        ),
        "utf8",
      );

      writeFileSync(
        join(workspace, ".brewva/brewva.json"),
        JSON.stringify(
          {
            verification: { defaultLevel: "strict" },
          },
          null,
          2,
        ),
        "utf8",
      );

      const loaded = loadBrewvaConfig({ cwd: workspace });
      expect(loaded.parallel.maxConcurrent).toBe(7);
      expect(loaded.verification.defaultLevel).toBe("strict");
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  test("does not fall back to legacy .pi config path", () => {
    const workspace = createWorkspace("legacy-fallback-disabled");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(
      join(workspace, ".pi/brewva.json"),
      JSON.stringify(
        {
          parallel: { maxConcurrent: 99 },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace });
    expect(loaded.parallel.maxConcurrent).toBe(DEFAULT_BREWVA_CONFIG.parallel.maxConcurrent);
  });
});
