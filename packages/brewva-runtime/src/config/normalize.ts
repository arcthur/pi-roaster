import type { BrewvaConfig } from "../types.js";

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

function normalizeTapePressureThresholds(
  value: unknown,
  fallback: { low: number; medium: number; high: number },
): { low: number; medium: number; high: number } {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  const low = normalizePositiveInteger(input.low, fallback.low);
  const medium = Math.max(
    low,
    normalizePositiveInteger(input.medium, fallback.medium),
  );
  const high = Math.max(
    medium,
    normalizePositiveInteger(input.high, fallback.high),
  );

  return { low, medium, high };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function normalizeBrewvaConfig(config: BrewvaConfig, defaults: BrewvaConfig): BrewvaConfig {
  const defaultContextBudget = defaults.infrastructure.contextBudget;
  const contextBudget = config.infrastructure.contextBudget;
  const normalizedHardLimitPercent = normalizeUnitInterval(contextBudget.hardLimitPercent, defaultContextBudget.hardLimitPercent);
  const normalizedCompactionThresholdPercent = Math.min(
    normalizeUnitInterval(contextBudget.compactionThresholdPercent, defaultContextBudget.compactionThresholdPercent),
    normalizedHardLimitPercent,
  );

  return {
    ...config,
    skills: {
      ...config.skills,
      roots: normalizeStringArray(config.skills.roots, defaults.skills.roots ?? []),
      packs: normalizeStringArray(config.skills.packs, defaults.skills.packs),
      disabled: normalizeStringArray(config.skills.disabled, defaults.skills.disabled),
      selector: {
        ...config.skills.selector,
        k: normalizePositiveInteger(config.skills.selector.k, defaults.skills.selector.k),
        maxDigestTokens: normalizePositiveInteger(
          config.skills.selector.maxDigestTokens,
          defaults.skills.selector.maxDigestTokens,
        ),
      },
    },
    ledger: {
      ...config.ledger,
      path: normalizeNonEmptyString(config.ledger.path, defaults.ledger.path),
      digestWindow: normalizePositiveInteger(config.ledger.digestWindow, defaults.ledger.digestWindow),
      checkpointEveryTurns: normalizeNonNegativeInteger(
        config.ledger.checkpointEveryTurns,
        defaults.ledger.checkpointEveryTurns,
      ),
    },
    tape: {
      ...config.tape,
      checkpointIntervalEntries: normalizeNonNegativeInteger(
        config.tape.checkpointIntervalEntries,
        defaults.tape.checkpointIntervalEntries,
      ),
      tapePressureThresholds: normalizeTapePressureThresholds(
        config.tape.tapePressureThresholds,
        defaults.tape.tapePressureThresholds,
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
      },
      interruptRecovery: {
        enabled: normalizeBoolean(
          config.infrastructure.interruptRecovery.enabled,
          defaults.infrastructure.interruptRecovery.enabled,
        ),
        gracefulTimeoutMs: normalizePositiveInteger(
          config.infrastructure.interruptRecovery.gracefulTimeoutMs,
          defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
        ),
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
