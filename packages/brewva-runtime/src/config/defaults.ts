import type { BrewvaConfig } from "../types.js";

export const DEFAULT_BREWVA_CONFIG: BrewvaConfig = {
  ui: {
    quietStartup: true,
  },
  skills: {
    roots: [],
    packs: ["skill-creator"],
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
    evolvesMode: "shadow",
    cognitive: {
      mode: "active",
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
