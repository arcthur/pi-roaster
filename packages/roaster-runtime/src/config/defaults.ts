import type { RoasterConfig } from "../types.js";

export const DEFAULT_ROASTER_CONFIG: RoasterConfig = {
  skills: {
    roots: [],
    packs: ["typescript", "react", "bun"],
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
  security: {
    sanitizeContext: true,
    enforceDeniedTools: true,
    allowedToolsMode: "warn",
    skillMaxTokensMode: "warn",
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
      compactionCircuitBreaker: {
        enabled: true,
        maxConsecutiveFailures: 2,
        cooldownTurns: 2,
      },
    },
    interruptRecovery: {
      enabled: true,
      snapshotsDir: ".orchestrator/state",
      gracefulTimeoutMs: 8000,
      resumeHintInSystemPrompt: true,
      resumeHintInjectionEnabled: true,
      sessionHandoff: {
        enabled: true,
        maxSummaryChars: 800,
        relevance: {
          enabled: true,
          goalWeight: 1.4,
          failureWeight: 1.2,
          recencyWeight: 0.8,
          artifactWeight: 0.6,
        },
        hierarchy: {
          enabled: true,
          branchFactor: 3,
          maxLevels: 3,
          entriesPerLevel: 3,
          maxCharsPerEntry: 240,
          goalFilterEnabled: true,
          minGoalScore: 0.34,
          maxInjectedEntries: 4,
        },
        injectionBudget: {
          enabled: true,
          maxTotalChars: 1600,
          maxUserPreferencesChars: 220,
          maxUserHandoffChars: 420,
          maxHierarchyChars: 640,
          maxUserDigestChars: 260,
          maxSessionHandoffChars: 520,
          maxSessionDigestChars: 320,
        },
        circuitBreaker: {
          enabled: true,
          maxConsecutiveFailures: 2,
          cooldownTurns: 2,
        },
      },
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
