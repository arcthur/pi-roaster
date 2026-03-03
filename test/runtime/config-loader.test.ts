import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("given schema-invalid config values, when loading config, then load fails fast", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("given removed truncation strategy summarize, when loading config, then load fails fast", () => {
    const workspace = createWorkspace("removed-truncation-summarize");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            contextBudget: {
              truncationStrategy: "summarize",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("given out-of-range memory config, when loading config, then load fails fast", () => {
    const workspace = createWorkspace("memory-range-invalid");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: true,
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
            evolvesMode: "review-gated",
            cognitive: {
              mode: "shadow",
              maxTokensPerTurn: -50,
            },
            global: {
              enabled: true,
              minConfidence: 9,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("given in-range memory config with fractional counters, when loading config, then counters are normalized deterministically", () => {
    const workspace = createWorkspace("memory-counter-normalize");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: true,
            maxWorkingChars: 2400.9,
            dailyRefreshHourLocal: 12.7,
            crystalMinUnits: 4.9,
            retrievalTopK: 8.4,
            retrievalWeights: {
              lexical: 2,
              recency: 2,
              confidence: 2,
            },
            cognitive: {
              mode: "shadow",
              maxTokensPerTurn: 1024.6,
            },
            global: {
              enabled: true,
              minConfidence: 0.95,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.memory.maxWorkingChars).toBe(2400);
    expect(loaded.memory.dailyRefreshHourLocal).toBe(12);
    expect(loaded.memory.crystalMinUnits).toBe(4);
    expect(loaded.memory.retrievalTopK).toBe(8);
    expect(loaded.memory.retrievalWeights.lexical).toBeCloseTo(1 / 3, 6);
    expect(loaded.memory.retrievalWeights.recency).toBeCloseTo(1 / 3, 6);
    expect(loaded.memory.retrievalWeights.confidence).toBeCloseTo(1 / 3, 6);
    expect(loaded.memory.cognitive.maxTokensPerTurn).toBe(1024);
    expect(loaded.memory.global.minConfidence).toBe(0.95);
  });

  test("given removed memory mode values, when loading config, then load fails fast", () => {
    const workspace = createWorkspace("memory-removed-modes");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            recallMode: "fallback",
            evolvesMode: "shadow",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /\/memory\/(recallMode|evolvesMode)/,
    );
  });

  test("given whitespace-padded string fields, when loading config, then values are trimmed", () => {
    const workspace = createWorkspace("trim-strings");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          ledger: {
            path: "  .orchestrator/ledger/evidence-custom.jsonl  ",
          },
          memory: {
            dir: "  .orchestrator/memory-custom  ",
            workingFile: "  working-custom.md  ",
          },
          schedule: {
            projectionPath: "  .brewva/schedule/custom-intents.jsonl  ",
          },
          infrastructure: {
            turnWal: {
              dir: "  .orchestrator/turn-wal-custom  ",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.ledger.path).toBe(".orchestrator/ledger/evidence-custom.jsonl");
    expect(loaded.memory.dir).toBe(".orchestrator/memory-custom");
    expect(loaded.memory.workingFile).toBe("working-custom.md");
    expect(loaded.schedule.projectionPath).toBe(".brewva/schedule/custom-intents.jsonl");
    expect(loaded.infrastructure.turnWal.dir).toBe(".orchestrator/turn-wal-custom");
  });

  test("given strict security config, when loading config, then execution config is normalized fail-closed", () => {
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
              commandDenyList: ["  IPTABLES  ", "", "  curl  "],
              sandbox: {
                serverUrl: "",
                apiKey: "  ",
                defaultImage: "",
                memory: 256,
                cpus: 2,
                timeout: 240,
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
    expect(loaded.security.execution.commandDenyList).toEqual(["iptables", "curl"]);
    expect(loaded.security.execution.sandbox.serverUrl).toBe(defaults.sandbox.serverUrl);
    expect(loaded.security.execution.sandbox.apiKey).toBe(defaults.sandbox.apiKey);
    expect(loaded.security.execution.sandbox.defaultImage).toBe(defaults.sandbox.defaultImage);
    expect(loaded.security.execution.sandbox.memory).toBe(256);
    expect(loaded.security.execution.sandbox.cpus).toBe(2);
    expect(loaded.security.execution.sandbox.timeout).toBe(240);
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

  test("given skills roots and fractional selector config, when loading config, then values are normalized", () => {
    const workspace = createWorkspace("skills-normalize");
    const rawConfig = {
      skills: {
        roots: ["  ./skills-extra  ", " "],
        packs: ["  typescript  ", " "],
        disabled: ["  review  ", " "],
        selector: {
          k: 4.8,
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
    expect(loaded.skills.selector.k).toBe(4);
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

  test("given $schema metadata field, when loading config, then schema hint is ignored", () => {
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

  test("given invalid JSON config file, when loading config, then load fails fast", () => {
    const workspace = createWorkspace("invalid-json");
    writeFileSync(join(workspace, ".brewva/brewva.json"), "{", "utf8");

    expect(() =>
      loadBrewvaConfig({
        cwd: workspace,
        configPath: ".brewva/brewva.json",
      }),
    ).toThrow(/Failed to parse config JSON/);
  });

  test("given unavailable schema path, when loading config, then load fails fast", () => {
    const workspace = createWorkspace("schema-unavailable");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify({ ui: { quietStartup: false } }, null, 2),
      "utf8",
    );

    const script = `
      import { loadBrewvaConfig } from "@brewva/brewva-runtime";
      try {
        loadBrewvaConfig({ cwd: process.env.BREWVA_TEST_WORKSPACE, configPath: ".brewva/brewva.json" });
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(17);
      }
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BREWVA_TEST_WORKSPACE: workspace,
        BREWVA_CONFIG_SCHEMA_PATH: "./definitely-missing-schema.json",
      },
      encoding: "utf8",
    });
    expect(child.status).toBe(17);
    expect(child.stderr.includes("Schema validation is unavailable")).toBe(true);
  });

  test("given unknown keys and malformed object shapes, when loading config, then load fails fast", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("given removed memory tuning keys, when loading config, then load fails fast", () => {
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

    expect(() =>
      loadBrewvaConfig({
        cwd: workspace,
        configPath: ".brewva/brewva.json",
      }),
    ).toThrow(/maxInferenceCallsPerRefresh/);
  });

  test("given tool output distillation injection config, when loading config, then schema accepts the key", () => {
    const workspace = createWorkspace("tool-output-distillation-schema");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            toolOutputDistillationInjection: {
              enabled: false,
              maxEntries: 2,
              maxOutputChars: 180,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(loaded.infrastructure.toolOutputDistillationInjection.enabled).toBe(false);
    expect(loaded.infrastructure.toolOutputDistillationInjection.maxEntries).toBe(2);
    expect(loaded.infrastructure.toolOutputDistillationInjection.maxOutputChars).toBe(180);
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

  test("given channel orchestration config with fractional limits, when loading config, then orchestration values are normalized", () => {
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
                telegram: [" 123 ", "", "@ops"],
              },
              limits: {
                fanoutMaxAgents: 3.8,
                maxDiscussionRounds: 4.8,
                a2aMaxDepth: 2.9,
                a2aMaxHops: 6.6,
                maxLiveRuntimes: 12,
                idleRuntimeTtlMs: 90_000.9,
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
    expect(loaded.channels.orchestration.limits.fanoutMaxAgents).toBe(3);
    expect(loaded.channels.orchestration.limits.maxDiscussionRounds).toBe(4);
    expect(loaded.channels.orchestration.limits.a2aMaxDepth).toBe(2);
    expect(loaded.channels.orchestration.limits.a2aMaxHops).toBe(6);
    expect(loaded.channels.orchestration.limits.maxLiveRuntimes).toBe(12);
    expect(loaded.channels.orchestration.limits.idleRuntimeTtlMs).toBe(90_000);
  });
});
