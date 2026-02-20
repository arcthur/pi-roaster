import type { BrewvaConfig, VerificationLevel } from "../types.js";

const VALID_TRUNCATION_STRATEGIES = new Set(["drop-entry", "summarize", "tail"]);
const VALID_COST_ACTIONS = new Set(["warn", "block_tools"]);
const VALID_ALLOWED_TOOLS_MODES = new Set(["off", "warn", "enforce"]);
const VALID_MEMORY_EVOLVES_MODES = new Set(["off", "shadow"]);
const VALID_VERIFICATION_LEVELS = new Set<VerificationLevel>(["quick", "standard", "strict"]);

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  const low = normalizePositiveInteger(input.low, fallback.low);
  const medium = Math.max(low, normalizePositiveInteger(input.medium, fallback.medium));
  const high = Math.max(medium, normalizePositiveInteger(input.high, fallback.high));

  return { low, medium, high };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeVerificationLevel(
  value: unknown,
  fallback: VerificationLevel,
): VerificationLevel {
  return VALID_VERIFICATION_LEVELS.has(value as VerificationLevel)
    ? (value as VerificationLevel)
    : fallback;
}

function normalizeStringRecord(
  value: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (!isRecord(value)) return { ...fallback };
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out[key] = entry;
  }
  return out;
}

function normalizeSkillOverrides(
  value: unknown,
  fallback: BrewvaConfig["skills"]["overrides"],
): BrewvaConfig["skills"]["overrides"] {
  if (!isRecord(value)) return structuredClone(fallback);
  const out: BrewvaConfig["skills"]["overrides"] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    out[key] = entry as BrewvaConfig["skills"]["overrides"][string];
  }
  return out;
}

function normalizeMemoryRetrievalWeights(
  value: unknown,
  fallback: BrewvaConfig["memory"]["retrievalWeights"],
): BrewvaConfig["memory"]["retrievalWeights"] {
  const input = isRecord(value) ? value : {};
  const lexical = normalizeNonNegativeNumber(input.lexical, fallback.lexical);
  const recency = normalizeNonNegativeNumber(input.recency, fallback.recency);
  const confidence = normalizeNonNegativeNumber(input.confidence, fallback.confidence);
  const total = lexical + recency + confidence;
  if (total <= 0) return { ...fallback };
  return {
    lexical: lexical / total,
    recency: recency / total,
    confidence: confidence / total,
  };
}

export function normalizeBrewvaConfig(config: unknown, defaults: BrewvaConfig): BrewvaConfig {
  const input = isRecord(config) ? config : {};
  const uiInput = isRecord(input.ui) ? input.ui : {};
  const skillsInput = isRecord(input.skills) ? input.skills : {};
  const skillsSelectorInput = isRecord(skillsInput.selector) ? skillsInput.selector : {};
  const verificationInput = isRecord(input.verification) ? input.verification : {};
  const verificationChecksInput = isRecord(verificationInput.checks)
    ? verificationInput.checks
    : {};
  const ledgerInput = isRecord(input.ledger) ? input.ledger : {};
  const tapeInput = isRecord(input.tape) ? input.tape : {};
  const memoryInput = isRecord(input.memory) ? input.memory : {};
  const securityInput = isRecord(input.security) ? input.security : {};
  const parallelInput = isRecord(input.parallel) ? input.parallel : {};
  const infrastructureInput = isRecord(input.infrastructure) ? input.infrastructure : {};
  const infrastructureEventsInput = isRecord(infrastructureInput.events)
    ? infrastructureInput.events
    : {};
  const contextBudgetInput = isRecord(infrastructureInput.contextBudget)
    ? infrastructureInput.contextBudget
    : {};
  const interruptRecoveryInput = isRecord(infrastructureInput.interruptRecovery)
    ? infrastructureInput.interruptRecovery
    : {};
  const costTrackingInput = isRecord(infrastructureInput.costTracking)
    ? infrastructureInput.costTracking
    : {};

  const defaultContextBudget = defaults.infrastructure.contextBudget;
  const normalizedHardLimitPercent = normalizeUnitInterval(
    contextBudgetInput.hardLimitPercent,
    defaultContextBudget.hardLimitPercent,
  );
  const normalizedCompactionThresholdPercent = Math.min(
    normalizeUnitInterval(
      contextBudgetInput.compactionThresholdPercent,
      defaultContextBudget.compactionThresholdPercent,
    ),
    normalizedHardLimitPercent,
  );

  return {
    ui: {
      quietStartup: normalizeBoolean(uiInput.quietStartup, defaults.ui.quietStartup),
      collapseChangelog: normalizeBoolean(uiInput.collapseChangelog, defaults.ui.collapseChangelog),
    },
    skills: {
      roots: normalizeStringArray(skillsInput.roots, defaults.skills.roots ?? []),
      packs: normalizeStringArray(skillsInput.packs, defaults.skills.packs),
      disabled: normalizeStringArray(skillsInput.disabled, defaults.skills.disabled),
      overrides: normalizeSkillOverrides(skillsInput.overrides, defaults.skills.overrides),
      selector: {
        k: normalizePositiveInteger(skillsSelectorInput.k, defaults.skills.selector.k),
        maxDigestTokens: normalizePositiveInteger(
          skillsSelectorInput.maxDigestTokens,
          defaults.skills.selector.maxDigestTokens,
        ),
      },
    },
    verification: {
      defaultLevel: normalizeVerificationLevel(
        verificationInput.defaultLevel,
        defaults.verification.defaultLevel,
      ),
      checks: {
        quick: normalizeStringArray(
          verificationChecksInput.quick,
          defaults.verification.checks.quick,
        ),
        standard: normalizeStringArray(
          verificationChecksInput.standard,
          defaults.verification.checks.standard,
        ),
        strict: normalizeStringArray(
          verificationChecksInput.strict,
          defaults.verification.checks.strict,
        ),
      },
      commands: normalizeStringRecord(verificationInput.commands, defaults.verification.commands),
    },
    ledger: {
      path: normalizeNonEmptyString(ledgerInput.path, defaults.ledger.path),
      digestWindow: normalizePositiveInteger(
        ledgerInput.digestWindow,
        defaults.ledger.digestWindow,
      ),
      checkpointEveryTurns: normalizeNonNegativeInteger(
        ledgerInput.checkpointEveryTurns,
        defaults.ledger.checkpointEveryTurns,
      ),
    },
    tape: {
      checkpointIntervalEntries: normalizeNonNegativeInteger(
        tapeInput.checkpointIntervalEntries,
        defaults.tape.checkpointIntervalEntries,
      ),
      tapePressureThresholds: normalizeTapePressureThresholds(
        tapeInput.tapePressureThresholds,
        defaults.tape.tapePressureThresholds,
      ),
    },
    memory: {
      enabled: normalizeBoolean(memoryInput.enabled, defaults.memory.enabled),
      dir: normalizeNonEmptyString(memoryInput.dir, defaults.memory.dir),
      workingFile: normalizeNonEmptyString(memoryInput.workingFile, defaults.memory.workingFile),
      maxWorkingChars: normalizePositiveInteger(
        memoryInput.maxWorkingChars,
        defaults.memory.maxWorkingChars,
      ),
      dailyRefreshHourLocal: Math.min(
        23,
        normalizeNonNegativeInteger(
          memoryInput.dailyRefreshHourLocal,
          defaults.memory.dailyRefreshHourLocal,
        ),
      ),
      crystalMinUnits: normalizePositiveInteger(
        memoryInput.crystalMinUnits,
        defaults.memory.crystalMinUnits,
      ),
      retrievalTopK: normalizePositiveInteger(
        memoryInput.retrievalTopK,
        defaults.memory.retrievalTopK,
      ),
      retrievalWeights: normalizeMemoryRetrievalWeights(
        memoryInput.retrievalWeights,
        defaults.memory.retrievalWeights,
      ),
      evolvesMode: VALID_MEMORY_EVOLVES_MODES.has(memoryInput.evolvesMode as string)
        ? (memoryInput.evolvesMode as BrewvaConfig["memory"]["evolvesMode"])
        : defaults.memory.evolvesMode,
    },
    security: {
      sanitizeContext: normalizeBoolean(
        securityInput.sanitizeContext,
        defaults.security.sanitizeContext,
      ),
      enforceDeniedTools: normalizeBoolean(
        securityInput.enforceDeniedTools,
        defaults.security.enforceDeniedTools,
      ),
      allowedToolsMode: VALID_ALLOWED_TOOLS_MODES.has(securityInput.allowedToolsMode as string)
        ? (securityInput.allowedToolsMode as BrewvaConfig["security"]["allowedToolsMode"])
        : defaults.security.allowedToolsMode,
      skillMaxTokensMode: VALID_ALLOWED_TOOLS_MODES.has(securityInput.skillMaxTokensMode as string)
        ? (securityInput.skillMaxTokensMode as BrewvaConfig["security"]["skillMaxTokensMode"])
        : defaults.security.skillMaxTokensMode,
      skillMaxToolCallsMode: VALID_ALLOWED_TOOLS_MODES.has(
        securityInput.skillMaxToolCallsMode as string,
      )
        ? (securityInput.skillMaxToolCallsMode as BrewvaConfig["security"]["skillMaxToolCallsMode"])
        : defaults.security.skillMaxToolCallsMode,
      skillMaxParallelMode: VALID_ALLOWED_TOOLS_MODES.has(
        securityInput.skillMaxParallelMode as string,
      )
        ? (securityInput.skillMaxParallelMode as BrewvaConfig["security"]["skillMaxParallelMode"])
        : defaults.security.skillMaxParallelMode,
    },
    parallel: {
      enabled: normalizeBoolean(parallelInput.enabled, defaults.parallel.enabled),
      maxConcurrent: normalizePositiveInteger(
        parallelInput.maxConcurrent,
        defaults.parallel.maxConcurrent,
      ),
      maxTotal: normalizePositiveInteger(parallelInput.maxTotal, defaults.parallel.maxTotal),
    },
    infrastructure: {
      events: {
        enabled: normalizeBoolean(
          infrastructureEventsInput.enabled,
          defaults.infrastructure.events.enabled,
        ),
        dir: normalizeNonEmptyString(
          infrastructureEventsInput.dir,
          defaults.infrastructure.events.dir,
        ),
      },
      contextBudget: {
        enabled: normalizeBoolean(contextBudgetInput.enabled, defaultContextBudget.enabled),
        maxInjectionTokens: normalizePositiveInteger(
          contextBudgetInput.maxInjectionTokens,
          defaultContextBudget.maxInjectionTokens,
        ),
        compactionThresholdPercent: normalizedCompactionThresholdPercent,
        hardLimitPercent: normalizedHardLimitPercent,
        minTurnsBetweenCompaction: normalizeNonNegativeInteger(
          contextBudgetInput.minTurnsBetweenCompaction,
          defaultContextBudget.minTurnsBetweenCompaction,
        ),
        minSecondsBetweenCompaction: normalizeNonNegativeNumber(
          contextBudgetInput.minSecondsBetweenCompaction,
          defaultContextBudget.minSecondsBetweenCompaction,
        ),
        pressureBypassPercent: normalizeUnitInterval(
          contextBudgetInput.pressureBypassPercent,
          defaultContextBudget.pressureBypassPercent,
        ),
        truncationStrategy: VALID_TRUNCATION_STRATEGIES.has(
          contextBudgetInput.truncationStrategy as string,
        )
          ? (contextBudgetInput.truncationStrategy as BrewvaConfig["infrastructure"]["contextBudget"]["truncationStrategy"])
          : defaultContextBudget.truncationStrategy,
        compactionInstructions: normalizeNonEmptyString(
          contextBudgetInput.compactionInstructions,
          defaultContextBudget.compactionInstructions,
        ),
      },
      interruptRecovery: {
        enabled: normalizeBoolean(
          interruptRecoveryInput.enabled,
          defaults.infrastructure.interruptRecovery.enabled,
        ),
        gracefulTimeoutMs: normalizePositiveInteger(
          interruptRecoveryInput.gracefulTimeoutMs,
          defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
        ),
      },
      costTracking: {
        enabled: normalizeBoolean(
          costTrackingInput.enabled,
          defaults.infrastructure.costTracking.enabled,
        ),
        maxCostUsdPerSession: normalizeNonNegativeNumber(
          costTrackingInput.maxCostUsdPerSession,
          defaults.infrastructure.costTracking.maxCostUsdPerSession,
        ),
        maxCostUsdPerSkill: normalizeNonNegativeNumber(
          costTrackingInput.maxCostUsdPerSkill,
          defaults.infrastructure.costTracking.maxCostUsdPerSkill,
        ),
        alertThresholdRatio: normalizeUnitInterval(
          costTrackingInput.alertThresholdRatio,
          defaults.infrastructure.costTracking.alertThresholdRatio,
        ),
        actionOnExceed: VALID_COST_ACTIONS.has(costTrackingInput.actionOnExceed as string)
          ? (costTrackingInput.actionOnExceed as BrewvaConfig["infrastructure"]["costTracking"]["actionOnExceed"])
          : defaults.infrastructure.costTracking.actionOnExceed,
      },
    },
  };
}
