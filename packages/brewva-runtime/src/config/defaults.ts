import type { BrewvaConfig } from "../types.js";

export const DEFAULT_BREWVA_CONFIG: BrewvaConfig = {
  ui: {
    quietStartup: true,
    collapseChangelog: true,
  },
  skills: {
    roots: [],
    packs: ["typescript", "react", "bun", "skill-creator"],
    disabled: [],
    overrides: {},
    selector: {
      k: 4,
      maxDigestTokens: 1200,
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
    digestWindow: 12,
    checkpointEveryTurns: 20,
  },
  tape: {
    checkpointIntervalEntries: 120,
    tapePressureThresholds: {
      low: 80,
      medium: 160,
      high: 280,
    },
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
    evolvesMode: "off",
  },
  security: {
    sanitizeContext: true,
    enforceDeniedTools: true,
    allowedToolsMode: "warn",
    skillMaxTokensMode: "warn",
    skillMaxToolCallsMode: "warn",
    skillMaxParallelMode: "warn",
  },
  parallel: {
    enabled: true,
    maxConcurrent: 3,
    maxTotal: 10,
  },
  infrastructure: {
    events: {
      enabled: true,
      dir: ".orchestrator/events",
    },
    contextBudget: {
      enabled: true,
      maxInjectionTokens: 1200,
      compactionThresholdPercent: 0.82,
      hardLimitPercent: 0.94,
      minTurnsBetweenCompaction: 2,
      minSecondsBetweenCompaction: 45,
      pressureBypassPercent: 0.94,
      truncationStrategy: "summarize",
      compactionInstructions:
        "Summarize stale tool outputs and keep only active objectives, unresolved failures, and latest verification evidence.",
    },
    interruptRecovery: {
      enabled: true,
      gracefulTimeoutMs: 8000,
    },
    costTracking: {
      enabled: true,
      maxCostUsdPerSession: 0,
      maxCostUsdPerSkill: 0,
      alertThresholdRatio: 0.8,
      actionOnExceed: "warn",
    },
  },
};
