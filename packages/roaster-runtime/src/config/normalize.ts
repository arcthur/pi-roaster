import type { RoasterConfig } from "../types.js";

const VALID_TRUNCATION_STRATEGIES = new Set(["drop-entry", "summarize", "tail"]);
const VALID_COST_ACTIONS = new Set(["warn", "block_tools"]);
const VALID_ALLOWED_TOOLS_MODES = new Set(["off", "warn", "enforce"]);

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function normalizeUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : fallback;
}

export function normalizeRoasterConfig(config: RoasterConfig, defaults: RoasterConfig): RoasterConfig {
  const defaultContextBudget = defaults.infrastructure.contextBudget;
  const contextBudget = config.infrastructure.contextBudget;
  const normalizedHardLimitPercent = normalizeUnitInterval(contextBudget.hardLimitPercent, defaultContextBudget.hardLimitPercent);
  const normalizedCompactionThresholdPercent = Math.min(
    normalizeUnitInterval(contextBudget.compactionThresholdPercent, defaultContextBudget.compactionThresholdPercent),
    normalizedHardLimitPercent,
  );

  const defaultSessionHandoff = defaults.infrastructure.interruptRecovery.sessionHandoff;
  const sessionHandoff = config.infrastructure.interruptRecovery.sessionHandoff;
  const hierarchyEntriesPerLevel = Math.max(
    2,
    normalizePositiveInteger(sessionHandoff.hierarchy.entriesPerLevel, defaultSessionHandoff.hierarchy.entriesPerLevel),
  );
  const hierarchyBranchFactor = Math.max(
    2,
    Math.min(
      hierarchyEntriesPerLevel,
      normalizePositiveInteger(sessionHandoff.hierarchy.branchFactor, defaultSessionHandoff.hierarchy.branchFactor),
    ),
  );

  return {
    ...config,
    ledger: {
      ...config.ledger,
      path: normalizeNonEmptyString(config.ledger.path, defaults.ledger.path),
      digestWindow: normalizePositiveInteger(config.ledger.digestWindow, defaults.ledger.digestWindow),
      checkpointEveryTurns: normalizeNonNegativeInteger(
        config.ledger.checkpointEveryTurns,
        defaults.ledger.checkpointEveryTurns,
      ),
    },
    security: {
      ...config.security,
      sanitizeContext: normalizeBoolean(config.security.sanitizeContext, defaults.security.sanitizeContext),
      enforceDeniedTools: normalizeBoolean(config.security.enforceDeniedTools, defaults.security.enforceDeniedTools),
      allowedToolsMode: VALID_ALLOWED_TOOLS_MODES.has(config.security.allowedToolsMode)
        ? config.security.allowedToolsMode
        : defaults.security.allowedToolsMode,
      skillMaxTokensMode: VALID_ALLOWED_TOOLS_MODES.has(config.security.skillMaxTokensMode)
        ? config.security.skillMaxTokensMode
        : defaults.security.skillMaxTokensMode,
      skillMaxParallelMode: VALID_ALLOWED_TOOLS_MODES.has(config.security.skillMaxParallelMode)
        ? config.security.skillMaxParallelMode
        : defaults.security.skillMaxParallelMode,
    },
    parallel: {
      ...config.parallel,
      enabled: normalizeBoolean(config.parallel.enabled, defaults.parallel.enabled),
      maxConcurrent: normalizePositiveInteger(config.parallel.maxConcurrent, defaults.parallel.maxConcurrent),
      maxTotal: normalizePositiveInteger(config.parallel.maxTotal, defaults.parallel.maxTotal),
    },
    infrastructure: {
      ...config.infrastructure,
      events: {
        ...config.infrastructure.events,
        enabled: normalizeBoolean(config.infrastructure.events.enabled, defaults.infrastructure.events.enabled),
        dir: normalizeNonEmptyString(config.infrastructure.events.dir, defaults.infrastructure.events.dir),
      },
      contextBudget: {
        ...contextBudget,
        enabled: normalizeBoolean(contextBudget.enabled, defaultContextBudget.enabled),
        maxInjectionTokens: normalizePositiveInteger(contextBudget.maxInjectionTokens, defaultContextBudget.maxInjectionTokens),
        compactionThresholdPercent: normalizedCompactionThresholdPercent,
        hardLimitPercent: normalizedHardLimitPercent,
        minTurnsBetweenCompaction: normalizeNonNegativeInteger(
          contextBudget.minTurnsBetweenCompaction,
          defaultContextBudget.minTurnsBetweenCompaction,
        ),
        minSecondsBetweenCompaction: normalizeNonNegativeNumber(
          contextBudget.minSecondsBetweenCompaction,
          defaultContextBudget.minSecondsBetweenCompaction,
        ),
        pressureBypassPercent: normalizeUnitInterval(
          contextBudget.pressureBypassPercent,
          defaultContextBudget.pressureBypassPercent,
        ),
        truncationStrategy: VALID_TRUNCATION_STRATEGIES.has(contextBudget.truncationStrategy)
          ? contextBudget.truncationStrategy
          : defaultContextBudget.truncationStrategy,
        compactionInstructions: normalizeNonEmptyString(
          contextBudget.compactionInstructions,
          defaultContextBudget.compactionInstructions,
        ),
        compactionCircuitBreaker: {
          ...contextBudget.compactionCircuitBreaker,
          enabled: normalizeBoolean(
            contextBudget.compactionCircuitBreaker.enabled,
            defaultContextBudget.compactionCircuitBreaker.enabled,
          ),
          maxConsecutiveFailures: normalizePositiveInteger(
            contextBudget.compactionCircuitBreaker.maxConsecutiveFailures,
            defaultContextBudget.compactionCircuitBreaker.maxConsecutiveFailures,
          ),
          cooldownTurns: normalizePositiveInteger(
            contextBudget.compactionCircuitBreaker.cooldownTurns,
            defaultContextBudget.compactionCircuitBreaker.cooldownTurns,
          ),
        },
      },
      interruptRecovery: {
        ...config.infrastructure.interruptRecovery,
        enabled: normalizeBoolean(
          config.infrastructure.interruptRecovery.enabled,
          defaults.infrastructure.interruptRecovery.enabled,
        ),
        snapshotsDir: normalizeNonEmptyString(
          config.infrastructure.interruptRecovery.snapshotsDir,
          defaults.infrastructure.interruptRecovery.snapshotsDir,
        ),
        gracefulTimeoutMs: normalizePositiveInteger(
          config.infrastructure.interruptRecovery.gracefulTimeoutMs,
          defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
        ),
        resumeHintInjectionEnabled: normalizeBoolean(
          config.infrastructure.interruptRecovery.resumeHintInjectionEnabled,
          defaults.infrastructure.interruptRecovery.resumeHintInjectionEnabled,
        ),
        resumeHintInSystemPrompt:
          typeof config.infrastructure.interruptRecovery.resumeHintInSystemPrompt === "boolean"
            ? config.infrastructure.interruptRecovery.resumeHintInSystemPrompt
            : defaults.infrastructure.interruptRecovery.resumeHintInSystemPrompt,
        sessionHandoff: {
          ...sessionHandoff,
          enabled: normalizeBoolean(sessionHandoff.enabled, defaultSessionHandoff.enabled),
          maxSummaryChars: normalizePositiveInteger(sessionHandoff.maxSummaryChars, defaultSessionHandoff.maxSummaryChars),
          relevance: {
            ...sessionHandoff.relevance,
            enabled: normalizeBoolean(sessionHandoff.relevance.enabled, defaultSessionHandoff.relevance.enabled),
            goalWeight: normalizeNonNegativeNumber(
              sessionHandoff.relevance.goalWeight,
              defaultSessionHandoff.relevance.goalWeight,
            ),
            failureWeight: normalizeNonNegativeNumber(
              sessionHandoff.relevance.failureWeight,
              defaultSessionHandoff.relevance.failureWeight,
            ),
            recencyWeight: normalizeNonNegativeNumber(
              sessionHandoff.relevance.recencyWeight,
              defaultSessionHandoff.relevance.recencyWeight,
            ),
            artifactWeight: normalizeNonNegativeNumber(
              sessionHandoff.relevance.artifactWeight,
              defaultSessionHandoff.relevance.artifactWeight,
            ),
          },
          hierarchy: {
            ...sessionHandoff.hierarchy,
            enabled: normalizeBoolean(sessionHandoff.hierarchy.enabled, defaultSessionHandoff.hierarchy.enabled),
            branchFactor: hierarchyBranchFactor,
            maxLevels: normalizePositiveInteger(sessionHandoff.hierarchy.maxLevels, defaultSessionHandoff.hierarchy.maxLevels),
            entriesPerLevel: hierarchyEntriesPerLevel,
            maxCharsPerEntry: normalizePositiveInteger(
              sessionHandoff.hierarchy.maxCharsPerEntry,
              defaultSessionHandoff.hierarchy.maxCharsPerEntry,
            ),
            goalFilterEnabled: normalizeBoolean(
              sessionHandoff.hierarchy.goalFilterEnabled,
              defaultSessionHandoff.hierarchy.goalFilterEnabled,
            ),
            minGoalScore: normalizeUnitInterval(
              sessionHandoff.hierarchy.minGoalScore,
              defaultSessionHandoff.hierarchy.minGoalScore,
            ),
            maxInjectedEntries: normalizePositiveInteger(
              sessionHandoff.hierarchy.maxInjectedEntries,
              defaultSessionHandoff.hierarchy.maxInjectedEntries,
            ),
          },
          injectionBudget: {
            ...sessionHandoff.injectionBudget,
            enabled: normalizeBoolean(sessionHandoff.injectionBudget.enabled, defaultSessionHandoff.injectionBudget.enabled),
            maxTotalChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxTotalChars,
              defaultSessionHandoff.injectionBudget.maxTotalChars,
            ),
            maxUserPreferencesChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxUserPreferencesChars,
              defaultSessionHandoff.injectionBudget.maxUserPreferencesChars,
            ),
            maxUserHandoffChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxUserHandoffChars,
              defaultSessionHandoff.injectionBudget.maxUserHandoffChars,
            ),
            maxHierarchyChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxHierarchyChars,
              defaultSessionHandoff.injectionBudget.maxHierarchyChars,
            ),
            maxUserDigestChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxUserDigestChars,
              defaultSessionHandoff.injectionBudget.maxUserDigestChars,
            ),
            maxSessionHandoffChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxSessionHandoffChars,
              defaultSessionHandoff.injectionBudget.maxSessionHandoffChars,
            ),
            maxSessionDigestChars: normalizePositiveInteger(
              sessionHandoff.injectionBudget.maxSessionDigestChars,
              defaultSessionHandoff.injectionBudget.maxSessionDigestChars,
            ),
          },
          circuitBreaker: {
            ...sessionHandoff.circuitBreaker,
            enabled: normalizeBoolean(sessionHandoff.circuitBreaker.enabled, defaultSessionHandoff.circuitBreaker.enabled),
            maxConsecutiveFailures: normalizePositiveInteger(
              sessionHandoff.circuitBreaker.maxConsecutiveFailures,
              defaultSessionHandoff.circuitBreaker.maxConsecutiveFailures,
            ),
            cooldownTurns: normalizePositiveInteger(
              sessionHandoff.circuitBreaker.cooldownTurns,
              defaultSessionHandoff.circuitBreaker.cooldownTurns,
            ),
          },
        },
      },
      costTracking: {
        ...config.infrastructure.costTracking,
        enabled: normalizeBoolean(config.infrastructure.costTracking.enabled, defaults.infrastructure.costTracking.enabled),
        maxCostUsdPerSession: normalizeNonNegativeNumber(
          config.infrastructure.costTracking.maxCostUsdPerSession,
          defaults.infrastructure.costTracking.maxCostUsdPerSession,
        ),
        maxCostUsdPerSkill: normalizeNonNegativeNumber(
          config.infrastructure.costTracking.maxCostUsdPerSkill,
          defaults.infrastructure.costTracking.maxCostUsdPerSkill,
        ),
        alertThresholdRatio: normalizeUnitInterval(
          config.infrastructure.costTracking.alertThresholdRatio,
          defaults.infrastructure.costTracking.alertThresholdRatio,
        ),
        actionOnExceed: VALID_COST_ACTIONS.has(config.infrastructure.costTracking.actionOnExceed)
          ? config.infrastructure.costTracking.actionOnExceed
          : defaults.infrastructure.costTracking.actionOnExceed,
      },
    },
  };
}
