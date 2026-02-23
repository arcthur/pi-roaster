import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  loadBrewvaConfig,
  loadBrewvaConfigWithDiagnostics,
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
      ui: {
        quietStartup: "yes",
      },
      tape: {
        checkpointIntervalEntries: -9,
      },
      infrastructure: {
        contextBudget: {
          maxInjectionTokens: -100,
          hardLimitPercent: 1.6,
          compactionThresholdPercent: 1.8,
          truncationStrategy: "invalid_strategy",
        },
        toolFailureInjection: {
          enabled: "yes",
          maxEntries: -2,
          maxOutputChars: 0,
        },
        interruptRecovery: {
          gracefulTimeoutMs: -1,
        },
        costTracking: {
          alertThresholdRatio: 2,
          actionOnExceed: "drop_session",
        },
        turnWal: {
          enabled: "yes",
          dir: "",
          defaultTtlMs: -1,
          maxRetries: -5,
          compactAfterMs: 0,
          scheduleTurnTtlMs: -10,
        },
      },
      schedule: {
        enabled: "yes",
        projectionPath: "",
        leaseDurationMs: -100,
        maxActiveIntentsPerSession: -2,
        maxActiveIntentsGlobal: 0,
        minIntervalMs: -1,
        maxConsecutiveErrors: -5,
        maxRecoveryCatchUps: 0,
      },
    };
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(rawConfig, null, 2),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const defaults = DEFAULT_BREWVA_CONFIG;

    expect(loaded.ui.quietStartup).toBe(defaults.ui.quietStartup);
    expect(loaded.tape.checkpointIntervalEntries).toBe(0);

    expect(loaded.infrastructure.contextBudget.maxInjectionTokens).toBe(
      defaults.infrastructure.contextBudget.maxInjectionTokens,
    );
    expect(loaded.infrastructure.contextBudget.hardLimitPercent).toBe(1);
    expect(loaded.infrastructure.contextBudget.compactionThresholdPercent).toBeLessThanOrEqual(
      loaded.infrastructure.contextBudget.hardLimitPercent,
    );
    expect(loaded.infrastructure.contextBudget.truncationStrategy).toBe(
      defaults.infrastructure.contextBudget.truncationStrategy,
    );
    expect(loaded.infrastructure.toolFailureInjection.enabled).toBe(
      defaults.infrastructure.toolFailureInjection.enabled,
    );
    expect(loaded.infrastructure.toolFailureInjection.maxEntries).toBe(
      defaults.infrastructure.toolFailureInjection.maxEntries,
    );
    expect(loaded.infrastructure.toolFailureInjection.maxOutputChars).toBe(
      defaults.infrastructure.toolFailureInjection.maxOutputChars,
    );

    expect(loaded.infrastructure.interruptRecovery.gracefulTimeoutMs).toBe(
      defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
    );

    expect(loaded.infrastructure.costTracking.alertThresholdRatio).toBe(1);
    expect(loaded.infrastructure.costTracking.actionOnExceed).toBe(
      defaults.infrastructure.costTracking.actionOnExceed,
    );
    expect(loaded.infrastructure.turnWal.enabled).toBe(defaults.infrastructure.turnWal.enabled);
    expect(loaded.infrastructure.turnWal.dir).toBe(defaults.infrastructure.turnWal.dir);
    expect(loaded.infrastructure.turnWal.defaultTtlMs).toBe(
      defaults.infrastructure.turnWal.defaultTtlMs,
    );
    expect(loaded.infrastructure.turnWal.maxRetries).toBe(0);
    expect(loaded.infrastructure.turnWal.compactAfterMs).toBe(
      defaults.infrastructure.turnWal.compactAfterMs,
    );
    expect(loaded.infrastructure.turnWal.scheduleTurnTtlMs).toBe(
      defaults.infrastructure.turnWal.scheduleTurnTtlMs,
    );

    expect(loaded.schedule.enabled).toBe(defaults.schedule.enabled);
    expect(loaded.schedule.projectionPath).toBe(defaults.schedule.projectionPath);
    expect(loaded.schedule.leaseDurationMs).toBe(defaults.schedule.leaseDurationMs);
    expect(loaded.schedule.maxActiveIntentsPerSession).toBe(
      defaults.schedule.maxActiveIntentsPerSession,
    );
    expect(loaded.schedule.maxActiveIntentsGlobal).toBe(defaults.schedule.maxActiveIntentsGlobal);
    expect(loaded.schedule.minIntervalMs).toBe(defaults.schedule.minIntervalMs);
    expect(loaded.schedule.maxConsecutiveErrors).toBe(defaults.schedule.maxConsecutiveErrors);
    expect(loaded.schedule.maxRecoveryCatchUps).toBe(defaults.schedule.maxRecoveryCatchUps);
  });

  test("normalizes memory config bounds and enum values", () => {
    const workspace = createWorkspace("memory-normalize");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: "yes",
            dir: "",
            workingFile: "",
            maxWorkingChars: -10,
            dailyRefreshHourLocal: 72,
            crystalMinUnits: 0,
            retrievalTopK: -1,
            retrievalWeights: {
              lexical: -1,
              recency: 2,
              confidence: 2,
            },
            evolvesMode: "unsupported",
            cognitive: {
              mode: "unsupported",
              maxTokensPerTurn: -50,
            },
            global: {
              enabled: "yes",
              minConfidence: 9,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const defaults = DEFAULT_BREWVA_CONFIG.memory;
    expect(loaded.memory.enabled).toBe(defaults.enabled);
    expect(loaded.memory.dir).toBe(defaults.dir);
    expect(loaded.memory.workingFile).toBe(defaults.workingFile);
    expect(loaded.memory.maxWorkingChars).toBe(defaults.maxWorkingChars);
    expect(loaded.memory.dailyRefreshHourLocal).toBe(23);
    expect(loaded.memory.crystalMinUnits).toBe(defaults.crystalMinUnits);
    expect(loaded.memory.retrievalTopK).toBe(defaults.retrievalTopK);
    expect(loaded.memory.retrievalWeights.lexical).toBe(0);
    expect(loaded.memory.retrievalWeights.recency).toBe(0.5);
    expect(loaded.memory.retrievalWeights.confidence).toBe(0.5);
    expect(loaded.memory.evolvesMode).toBe(defaults.evolvesMode);
    expect(loaded.memory.cognitive.mode).toBe(defaults.cognitive.mode);
    expect(loaded.memory.cognitive.maxTokensPerTurn).toBe(0);
    expect(loaded.memory.global.enabled).toBe(defaults.global.enabled);
    expect(loaded.memory.global.minConfidence).toBe(1);
  });

  test("returns isolated config instances when no config file exists", () => {
    const workspace = createWorkspace("isolation");

    const first = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    first.security.mode = "permissive";

    const second = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(second.security.mode).toBe(DEFAULT_BREWVA_CONFIG.security.mode);
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
        },
      },
    };
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(rawConfig, null, 2),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.skills.roots).toEqual([join(workspace, ".brewva/skills-extra")]);
    expect(loaded.skills.packs).toEqual(["typescript"]);
    expect(loaded.skills.disabled).toEqual(["review"]);
    expect(loaded.skills.selector.k).toBe(DEFAULT_BREWVA_CONFIG.skills.selector.k);
  });

  test("loads explicit ui startup overrides", () => {
    const workspace = createWorkspace("ui-overrides");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          ui: {
            quietStartup: false,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.ui.quietStartup).toBe(false);
  });

  test("tolerates $schema meta field in config files", () => {
    const workspace = createWorkspace("schema-meta");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          $schema: "../../node_modules/@brewva/brewva-runtime/schema/brewva.schema.json",
          ui: {
            quietStartup: false,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.ui.quietStartup).toBe(false);
  });

  test("tolerates invalid JSON config and reports diagnostics", () => {
    const workspace = createWorkspace("invalid-json");
    writeFileSync(join(workspace, ".brewva/brewva.json"), "{", "utf8");

    const loaded = loadBrewvaConfigWithDiagnostics({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(loaded.config.ui.quietStartup).toBe(DEFAULT_BREWVA_CONFIG.ui.quietStartup);
    expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config_parse_error")).toBe(
      true,
    );
  });

  test("drops unknown keys and tolerates invalid object shapes", () => {
    const workspace = createWorkspace("invalid-shapes");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          foo: 1,
          ui: null,
          verification: "nope",
          skills: "oops",
          infrastructure: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect((loaded as unknown as Record<string, unknown>).foo).toBeUndefined();
    expect(loaded.ui).toEqual(DEFAULT_BREWVA_CONFIG.ui);
    expect(loaded.verification.defaultLevel).toBe(DEFAULT_BREWVA_CONFIG.verification.defaultLevel);
  });

  test("reports removed memory tuning keys as schema diagnostics", () => {
    const workspace = createWorkspace("removed-memory-keys");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            cognitive: {
              maxInferenceCallsPerRefresh: 3,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfigWithDiagnostics({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(
      loaded.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "config_schema_invalid" &&
          diagnostic.message.includes('unknown property "maxInferenceCallsPerRefresh"'),
      ),
    ).toBe(true);
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
});
