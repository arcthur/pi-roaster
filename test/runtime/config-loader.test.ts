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
  test("given malformed config values, when loading config, then clamps ranges and preserves invariants", () => {
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
          strategy: {
            defaultArm: "invalid_arm",
            enableAutoByContextWindow: "yes",
            hybridContextWindowMin: -10,
            passthroughContextWindowMin: -20,
            overridesPath: "",
          },
          adaptiveZones: {
            retirement: {
              enabled: "yes",
              metricKey: "invalid_metric",
              disableBelow: 2,
              reenableAbove: -1,
              checkIntervalHours: -1,
              minSamples: 0,
            },
          },
          stabilityMonitor: {
            enabled: "yes",
            consecutiveThreshold: -2,
            retirement: {
              enabled: "yes",
              metricKey: "invalid_metric",
              disableBelow: 9,
              reenableAbove: -5,
              checkIntervalHours: 0,
              minSamples: -3,
            },
          },
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
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.enabled).toBe(
      defaults.infrastructure.contextBudget.stabilityMonitor.enabled,
    );
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.consecutiveThreshold).toBe(
      defaults.infrastructure.contextBudget.stabilityMonitor.consecutiveThreshold,
    );
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.retirement.enabled).toBe(
      defaults.infrastructure.contextBudget.stabilityMonitor.retirement.enabled,
    );
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.retirement.metricKey).toBe(
      defaults.infrastructure.contextBudget.stabilityMonitor.retirement.metricKey,
    );
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.retirement.disableBelow).toBe(1);
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.retirement.reenableAbove).toBe(1);
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.retirement.checkIntervalHours).toBe(
      defaults.infrastructure.contextBudget.stabilityMonitor.retirement.checkIntervalHours,
    );
    expect(loaded.infrastructure.contextBudget.stabilityMonitor.retirement.minSamples).toBe(
      defaults.infrastructure.contextBudget.stabilityMonitor.retirement.minSamples,
    );
    expect(loaded.infrastructure.contextBudget.adaptiveZones.retirement.enabled).toBe(
      defaults.infrastructure.contextBudget.adaptiveZones.retirement.enabled,
    );
    expect(loaded.infrastructure.contextBudget.adaptiveZones.retirement.metricKey).toBe(
      defaults.infrastructure.contextBudget.adaptiveZones.retirement.metricKey,
    );
    expect(loaded.infrastructure.contextBudget.adaptiveZones.retirement.disableBelow).toBe(1);
    expect(loaded.infrastructure.contextBudget.adaptiveZones.retirement.reenableAbove).toBe(1);
    expect(loaded.infrastructure.contextBudget.adaptiveZones.retirement.checkIntervalHours).toBe(
      defaults.infrastructure.contextBudget.adaptiveZones.retirement.checkIntervalHours,
    );
    expect(loaded.infrastructure.contextBudget.adaptiveZones.retirement.minSamples).toBe(
      defaults.infrastructure.contextBudget.adaptiveZones.retirement.minSamples,
    );
    expect(loaded.infrastructure.contextBudget.strategy).toEqual(
      defaults.infrastructure.contextBudget.strategy,
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

  test("given malformed memory config, when loading config, then bounds and enums are normalized", () => {
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

  test("given strict security config with invalid execution fields, when loading config, then execution config is normalized fail-closed", () => {
    const workspace = createWorkspace("security-execution-normalize");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            mode: "strict",
            execution: {
              backend: "host",
              fallbackToHost: true,
              commandDenyList: ["  IPTABLES  ", "", 3],
              sandbox: {
                serverUrl: "",
                apiKey: "  ",
                defaultImage: "",
                memory: -1,
                cpus: 0,
                timeout: -1,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const defaults = DEFAULT_BREWVA_CONFIG.security.execution;

    expect(loaded.security.mode).toBe("strict");
    expect(loaded.security.execution.backend).toBe("sandbox");
    expect(loaded.security.execution.enforceIsolation).toBe(defaults.enforceIsolation);
    expect(loaded.security.execution.fallbackToHost).toBe(false);
    expect(loaded.security.execution.commandDenyList).toEqual(["iptables"]);
    expect(loaded.security.execution.sandbox.serverUrl).toBe(defaults.sandbox.serverUrl);
    expect(loaded.security.execution.sandbox.apiKey).toBe(defaults.sandbox.apiKey);
    expect(loaded.security.execution.sandbox.defaultImage).toBe(defaults.sandbox.defaultImage);
    expect(loaded.security.execution.sandbox.memory).toBe(defaults.sandbox.memory);
    expect(loaded.security.execution.sandbox.cpus).toBe(defaults.sandbox.cpus);
    expect(loaded.security.execution.sandbox.timeout).toBe(defaults.sandbox.timeout);
  });

  test("given enforceIsolation enabled, when loading config, then sandbox backend is forced and host fallback is disabled", () => {
    const workspace = createWorkspace("security-execution-enforce-isolation");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            mode: "permissive",
            execution: {
              backend: "host",
              enforceIsolation: true,
              fallbackToHost: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.security.mode).toBe("permissive");
    expect(loaded.security.execution.enforceIsolation).toBe(true);
    expect(loaded.security.execution.backend).toBe("sandbox");
    expect(loaded.security.execution.fallbackToHost).toBe(false);
  });

  test("given no config file, when loading config multiple times, then each call returns an isolated config instance", () => {
    const workspace = createWorkspace("isolation");

    const first = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    first.security.mode = "permissive";

    const second = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(second.security.mode).toBe(DEFAULT_BREWVA_CONFIG.security.mode);
  });

  test("given malformed skills roots and selector config, when loading config, then values are normalized", () => {
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

  test("given ui startup overrides in config, when loading config, then startup settings are applied", () => {
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

  test("given $schema metadata field, when loading config, then schema hint is ignored without diagnostics", () => {
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

  test("given invalid JSON config file, when loading with diagnostics, then defaults are used and parse diagnostics are emitted", () => {
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

  test("given unknown keys and malformed object shapes, when loading with diagnostics, then unknown keys are dropped", () => {
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

  test("given removed memory tuning keys, when loading with diagnostics, then removed-key diagnostics are reported", () => {
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

  test("given global and project configs, when loading config, then project values take precedence", () => {
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

  test("given channel orchestration config, when loading config, then orchestration values are normalized", () => {
    const workspace = createWorkspace("channels-orchestration");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          channels: {
            orchestration: {
              enabled: true,
              scopeStrategy: "thread",
              aclModeWhenOwnersEmpty: "closed",
              owners: {
                telegram: [" 123 ", "", null, "@ops"],
              },
              limits: {
                fanoutMaxAgents: 0,
                maxDiscussionRounds: 4.8,
                a2aMaxDepth: -1,
                a2aMaxHops: "5",
                maxLiveRuntimes: 12,
                idleRuntimeTtlMs: 0,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.channels.orchestration.enabled).toBe(true);
    expect(loaded.channels.orchestration.scopeStrategy).toBe("thread");
    expect(loaded.channels.orchestration.aclModeWhenOwnersEmpty).toBe("closed");
    expect(loaded.channels.orchestration.owners.telegram).toEqual(["123", "@ops"]);
    expect(loaded.channels.orchestration.limits.fanoutMaxAgents).toBe(
      DEFAULT_BREWVA_CONFIG.channels.orchestration.limits.fanoutMaxAgents,
    );
    expect(loaded.channels.orchestration.limits.maxDiscussionRounds).toBe(4);
    expect(loaded.channels.orchestration.limits.a2aMaxDepth).toBe(
      DEFAULT_BREWVA_CONFIG.channels.orchestration.limits.a2aMaxDepth,
    );
    expect(loaded.channels.orchestration.limits.a2aMaxHops).toBe(
      DEFAULT_BREWVA_CONFIG.channels.orchestration.limits.a2aMaxHops,
    );
    expect(loaded.channels.orchestration.limits.maxLiveRuntimes).toBe(12);
    expect(loaded.channels.orchestration.limits.idleRuntimeTtlMs).toBe(
      DEFAULT_BREWVA_CONFIG.channels.orchestration.limits.idleRuntimeTtlMs,
    );
  });
});
