import type { BrewvaConfig } from "../types.js";

export const DEFAULT_BREWVA_CONFIG: BrewvaConfig = {
  ui: {
    quietStartup: true,
  },
  skills: {
    roots: [],
    packs: ["skill-creator", "telegram-interactive-components"],
    disabled: [],
    overrides: {},
    selector: {
      k: 4,
    },
  },
  verification: {
    defaultLevel: "standard",
    checks: {
      quick: ["type-check"],
      standard: ["type-check", "tests", "lint"],
      strict: ["type-check", "tests", "lint", "diff-review"],
    },
    commands: {
      "type-check": "bun run typecheck",
      tests: "bun test",
      lint: "bunx tsc --noEmit",
      "diff-review": "git diff --stat",
    },
  },
  ledger: {
    path: ".orchestrator/ledger/evidence.jsonl",
    checkpointEveryTurns: 20,
  },
  tape: {
    checkpointIntervalEntries: 120,
  },
  memory: {
    enabled: true,
    dir: ".orchestrator/memory",
    workingFile: "working.md",
    maxWorkingChars: 2400,
    dailyRefreshHourLocal: 8,
    crystalMinUnits: 4,
    retrievalTopK: 8,
    retrievalWeights: {
      lexical: 0.55,
      recency: 0.25,
      confidence: 0.2,
    },
    recallMode: "primary",
    externalRecall: {
      enabled: false,
      minInternalScore: 0.62,
      queryTopK: 5,
      injectedConfidence: 0.6,
    },
    evolvesMode: "shadow",
    cognitive: {
      mode: "shadow",
      maxTokensPerTurn: 0,
    },
    global: {
      enabled: true,
      minConfidence: 0.8,
    },
  },
  security: {
    mode: "standard",
    sanitizeContext: true,
    execution: {
      backend: "auto",
      enforceIsolation: false,
      fallbackToHost: true,
      commandDenyList: [],
      sandbox: {
        serverUrl: "http://127.0.0.1:5555",
        defaultImage: "microsandbox/node",
        memory: 512,
        cpus: 1,
        timeout: 180,
      },
    },
  },
  schedule: {
    enabled: true,
    projectionPath: ".brewva/schedule/intents.jsonl",
    leaseDurationMs: 60_000,
    maxActiveIntentsPerSession: 5,
    maxActiveIntentsGlobal: 20,
    minIntervalMs: 60_000,
    maxConsecutiveErrors: 3,
    maxRecoveryCatchUps: 5,
  },
  parallel: {
    enabled: true,
    maxConcurrent: 3,
  },
  channels: {
    orchestration: {
      enabled: true,
      scopeStrategy: "chat",
      aclModeWhenOwnersEmpty: "open",
      owners: {
        telegram: [],
      },
      limits: {
        fanoutMaxAgents: 4,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 4,
        a2aMaxHops: 6,
        maxLiveRuntimes: 8,
        idleRuntimeTtlMs: 900_000,
      },
    },
  },
  infrastructure: {
    events: {
      enabled: true,
      dir: ".orchestrator/events",
      level: "ops",
    },
    contextBudget: {
      enabled: true,
      maxInjectionTokens: 1200,
      compactionThresholdPercent: 0.82,
      hardLimitPercent: 0.94,
      truncationStrategy: "summarize",
      compactionInstructions:
        "Summarize stale tool outputs and keep only active objectives, unresolved failures, and latest verification evidence.",
      compaction: {
        minTurnsBetween: 2,
        minSecondsBetween: 45,
        pressureBypassPercent: 0.94,
      },
      adaptiveZones: {
        enabled: true,
        emaAlpha: 0.3,
        minTurnsBeforeAdapt: 3,
        stepTokens: 32,
        maxShiftPerTurn: 96,
        upshiftTruncationRatio: 0.25,
        downshiftIdleRatio: 0.15,
        retirement: {
          enabled: false,
          metricKey: "zone_adaptation_benefit_7d",
          disableBelow: 0.02,
          reenableAbove: 0.05,
          checkIntervalHours: 168,
          minSamples: 50,
        },
      },
      floorUnmetPolicy: {
        enabled: true,
        relaxOrder: ["memory_recall", "tool_failures", "memory_working"],
        finalFallback: "critical_only",
        requestCompaction: true,
      },
      stabilityMonitor: {
        enabled: true,
        consecutiveThreshold: 3,
        retirement: {
          enabled: false,
          metricKey: "floor_unmet_rate_7d",
          disableBelow: 0.01,
          reenableAbove: 0.03,
          checkIntervalHours: 168,
          minSamples: 50,
        },
      },
      strategy: {
        defaultArm: "managed",
        enableAutoByContextWindow: true,
        hybridContextWindowMin: 256_000,
        passthroughContextWindowMin: 1_000_000,
        overridesPath: ".brewva/strategy/context-strategy.json",
      },
      arena: {
        maxEntriesPerSession: 4096,
        degradationPolicy: "drop_recall",
        zones: {
          identity: { min: 0, max: 320 },
          truth: { min: 0, max: 420 },
          taskState: { min: 0, max: 360 },
          toolFailures: { min: 0, max: 480 },
          memoryWorking: { min: 0, max: 300 },
          memoryRecall: { min: 0, max: 600 },
          ragExternal: { min: 0, max: 0 },
        },
      },
    },
    toolFailureInjection: {
      enabled: true,
      maxEntries: 3,
      maxOutputChars: 300,
    },
    interruptRecovery: {
      enabled: true,
      gracefulTimeoutMs: 8000,
    },
    costTracking: {
      enabled: true,
      maxCostUsdPerSession: 0,
      alertThresholdRatio: 0.8,
      actionOnExceed: "warn",
    },
    turnWal: {
      enabled: true,
      dir: ".orchestrator/turn-wal",
      defaultTtlMs: 300_000,
      maxRetries: 2,
      compactAfterMs: 3_600_000,
      scheduleTurnTtlMs: 600_000,
    },
  },
};
