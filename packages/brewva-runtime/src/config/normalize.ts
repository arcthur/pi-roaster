import type { BrewvaConfig, VerificationLevel } from "../types.js";

const VALID_TRUNCATION_STRATEGIES = new Set(["drop-entry", "summarize", "tail"]);
const VALID_COST_ACTIONS = new Set(["warn", "block_tools"]);
const VALID_SECURITY_MODES = new Set(["permissive", "standard", "strict"]);
const VALID_EXECUTION_BACKENDS = new Set(["host", "sandbox", "auto"]);
const VALID_EVENT_LEVELS = new Set(["audit", "ops", "debug"]);
const VALID_MEMORY_EVOLVES_MODES = new Set(["off", "shadow"]);
const VALID_MEMORY_COGNITIVE_MODES = new Set(["off", "shadow", "active"]);
const VALID_MEMORY_RECALL_MODES = new Set(["primary", "fallback"]);
const VALID_MEMORY_EXTERNAL_RECALL_BUILTIN_PROVIDERS = new Set(["off", "crystal-lexical"]);
const VALID_VERIFICATION_LEVELS = new Set<VerificationLevel>(["quick", "standard", "strict"]);
const VALID_CHANNEL_SCOPE_STRATEGIES = new Set(["chat", "thread"]);
const VALID_CHANNEL_ACL_MODES = new Set(["open", "closed"]);
const VALID_CONTEXT_ARENA_DEGRADATION_POLICIES = new Set([
  "drop_recall",
  "drop_low_priority",
  "force_compact",
]);
const VALID_CONTEXT_FLOOR_UNMET_FALLBACKS = new Set(["critical_only"]);
const VALID_CONTEXT_BUDGET_PROFILES = new Set(["simple", "managed"]);
const VALID_CONTEXT_RETIREMENT_METRICS = new Set([
  "floor_unmet_rate_7d",
  "zone_adaptation_benefit_7d",
]);

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
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeLowercaseStringArray(value: unknown, fallback: string[]): string[] {
  const normalized = normalizeStringArray(value, fallback)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set(normalized)];
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

function normalizeContextArenaZone(
  value: unknown,
  fallback: { min: number; max: number },
): { min: number; max: number } {
  const input = isRecord(value) ? value : {};
  const min = normalizeNonNegativeInteger(input.min, fallback.min);
  const rawMax = normalizeNonNegativeInteger(input.max, fallback.max);
  return {
    min,
    max: Math.max(min, rawMax),
  };
}

function normalizeContextBudgetZoneOrder(
  value: unknown,
  fallback: BrewvaConfig["infrastructure"]["contextBudget"]["floorUnmetPolicy"]["relaxOrder"],
): BrewvaConfig["infrastructure"]["contextBudget"]["floorUnmetPolicy"]["relaxOrder"] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set([
    "identity",
    "truth",
    "skills",
    "task_state",
    "tool_failures",
    "memory_working",
    "memory_recall",
    "rag_external",
  ]);
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => allowed.has(entry))
    .filter((entry, index, array) => array.indexOf(entry) === index);
  return normalized.length > 0
    ? (normalized as BrewvaConfig["infrastructure"]["contextBudget"]["floorUnmetPolicy"]["relaxOrder"])
    : [...fallback];
}

function normalizeContextRetirementPolicy(
  value: unknown,
  fallback: BrewvaConfig["infrastructure"]["contextBudget"]["adaptiveZones"]["retirement"],
): BrewvaConfig["infrastructure"]["contextBudget"]["adaptiveZones"]["retirement"] {
  const input = isRecord(value) ? value : {};
  const metricCandidate =
    typeof input.metricKey === "string" && VALID_CONTEXT_RETIREMENT_METRICS.has(input.metricKey)
      ? input.metricKey
      : fallback.metricKey;
  const disableBelow = normalizeUnitInterval(input.disableBelow, fallback.disableBelow);
  const reenableFallback = Math.max(fallback.reenableAbove, disableBelow);
  const reenableAbove = Math.max(
    disableBelow,
    normalizeUnitInterval(input.reenableAbove, reenableFallback),
  );
  return {
    enabled: normalizeBoolean(input.enabled, fallback.enabled),
    metricKey:
      metricCandidate as BrewvaConfig["infrastructure"]["contextBudget"]["adaptiveZones"]["retirement"]["metricKey"],
    disableBelow,
    reenableAbove,
    checkIntervalHours: normalizePositiveInteger(
      input.checkIntervalHours,
      fallback.checkIntervalHours,
    ),
    minSamples: normalizePositiveInteger(input.minSamples, fallback.minSamples),
  };
}

export function normalizeBrewvaConfig(config: unknown, defaults: BrewvaConfig): BrewvaConfig {
  const input = isRecord(config) ? config : {};
  const uiInput = isRecord(input.ui) ? input.ui : {};
  const skillsInput = isRecord(input.skills) ? input.skills : {};
  const skillsSelectorInput = isRecord(skillsInput.selector) ? skillsInput.selector : {};
  const skillsSelectorSemanticFallbackInput = isRecord(skillsSelectorInput.semanticFallback)
    ? skillsSelectorInput.semanticFallback
    : {};
  const verificationInput = isRecord(input.verification) ? input.verification : {};
  const verificationChecksInput = isRecord(verificationInput.checks)
    ? verificationInput.checks
    : {};
  const ledgerInput = isRecord(input.ledger) ? input.ledger : {};
  const tapeInput = isRecord(input.tape) ? input.tape : {};
  const memoryInput = isRecord(input.memory) ? input.memory : {};
  const memoryCognitiveInput = isRecord(memoryInput.cognitive) ? memoryInput.cognitive : {};
  const memoryGlobalInput = isRecord(memoryInput.global) ? memoryInput.global : {};
  const memoryExternalRecallInput = isRecord(memoryInput.externalRecall)
    ? memoryInput.externalRecall
    : {};
  const securityInput = isRecord(input.security) ? input.security : {};
  const securityExecutionInput = isRecord(securityInput.execution) ? securityInput.execution : {};
  const securityExecutionSandboxInput = isRecord(securityExecutionInput.sandbox)
    ? securityExecutionInput.sandbox
    : {};
  const scheduleInput = isRecord(input.schedule) ? input.schedule : {};
  const parallelInput = isRecord(input.parallel) ? input.parallel : {};
  const channelsInput = isRecord(input.channels) ? input.channels : {};
  const channelsOrchestrationInput = isRecord(channelsInput.orchestration)
    ? channelsInput.orchestration
    : {};
  const channelsOwnersInput = isRecord(channelsOrchestrationInput.owners)
    ? channelsOrchestrationInput.owners
    : {};
  const channelsLimitsInput = isRecord(channelsOrchestrationInput.limits)
    ? channelsOrchestrationInput.limits
    : {};
  const infrastructureInput = isRecord(input.infrastructure) ? input.infrastructure : {};
  const infrastructureEventsInput = isRecord(infrastructureInput.events)
    ? infrastructureInput.events
    : {};
  const contextBudgetInput = isRecord(infrastructureInput.contextBudget)
    ? infrastructureInput.contextBudget
    : {};
  const contextBudgetCompactionInput = isRecord(contextBudgetInput.compaction)
    ? contextBudgetInput.compaction
    : {};
  const contextBudgetAdaptiveZonesInput = isRecord(contextBudgetInput.adaptiveZones)
    ? contextBudgetInput.adaptiveZones
    : {};
  const contextBudgetFloorUnmetPolicyInput = isRecord(contextBudgetInput.floorUnmetPolicy)
    ? contextBudgetInput.floorUnmetPolicy
    : {};
  const contextBudgetStabilityMonitorInput = isRecord(contextBudgetInput.stabilityMonitor)
    ? contextBudgetInput.stabilityMonitor
    : {};
  const contextBudgetArenaInput = isRecord(contextBudgetInput.arena)
    ? contextBudgetInput.arena
    : {};
  const contextBudgetArenaZonesInput = isRecord(contextBudgetArenaInput.zones)
    ? contextBudgetArenaInput.zones
    : {};
  const toolFailureInjectionInput = isRecord(infrastructureInput.toolFailureInjection)
    ? infrastructureInput.toolFailureInjection
    : {};
  const interruptRecoveryInput = isRecord(infrastructureInput.interruptRecovery)
    ? infrastructureInput.interruptRecovery
    : {};
  const costTrackingInput = isRecord(infrastructureInput.costTracking)
    ? infrastructureInput.costTracking
    : {};
  const turnWalInput = isRecord(infrastructureInput.turnWal) ? infrastructureInput.turnWal : {};

  const defaultContextBudget = defaults.infrastructure.contextBudget;
  const defaultToolFailureInjection = defaults.infrastructure.toolFailureInjection;
  const defaultContextCompaction = defaultContextBudget.compaction;
  const defaultContextAdaptiveZones = defaultContextBudget.adaptiveZones;
  const defaultContextFloorUnmetPolicy = defaultContextBudget.floorUnmetPolicy;
  const defaultContextStabilityMonitor = defaultContextBudget.stabilityMonitor;
  const defaultContextArena = defaultContextBudget.arena;
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
  const normalizedSecurityMode = VALID_SECURITY_MODES.has(securityInput.mode as string)
    ? (securityInput.mode as BrewvaConfig["security"]["mode"])
    : defaults.security.mode;
  const normalizedExecutionEnforceIsolation = normalizeBoolean(
    securityExecutionInput.enforceIsolation,
    defaults.security.execution.enforceIsolation,
  );
  const configuredExecutionBackend = VALID_EXECUTION_BACKENDS.has(
    securityExecutionInput.backend as string,
  )
    ? (securityExecutionInput.backend as BrewvaConfig["security"]["execution"]["backend"])
    : defaults.security.execution.backend;
  const normalizedExecutionBackend = normalizedExecutionEnforceIsolation
    ? "sandbox"
    : normalizedSecurityMode === "strict"
      ? "sandbox"
      : configuredExecutionBackend;
  const normalizedExecutionFallback =
    normalizedExecutionEnforceIsolation || normalizedSecurityMode === "strict"
      ? false
      : normalizeBoolean(
          securityExecutionInput.fallbackToHost,
          defaults.security.execution.fallbackToHost,
        );

  return {
    ui: {
      quietStartup: normalizeBoolean(uiInput.quietStartup, defaults.ui.quietStartup),
    },
    skills: {
      roots: normalizeStringArray(skillsInput.roots, defaults.skills.roots ?? []),
      packs: normalizeStringArray(skillsInput.packs, defaults.skills.packs),
      disabled: normalizeStringArray(skillsInput.disabled, defaults.skills.disabled),
      overrides: normalizeSkillOverrides(skillsInput.overrides, defaults.skills.overrides),
      selector: {
        k: normalizePositiveInteger(skillsSelectorInput.k, defaults.skills.selector.k),
        semanticFallback: {
          enabled: normalizeBoolean(
            skillsSelectorSemanticFallbackInput.enabled,
            defaults.skills.selector.semanticFallback.enabled,
          ),
          lexicalBypassScore: normalizeNonNegativeNumber(
            skillsSelectorSemanticFallbackInput.lexicalBypassScore,
            defaults.skills.selector.semanticFallback.lexicalBypassScore,
          ),
          minSimilarity: normalizeUnitInterval(
            skillsSelectorSemanticFallbackInput.minSimilarity,
            defaults.skills.selector.semanticFallback.minSimilarity,
          ),
          embeddingDimensions: Math.max(
            64,
            normalizePositiveInteger(
              skillsSelectorSemanticFallbackInput.embeddingDimensions,
              defaults.skills.selector.semanticFallback.embeddingDimensions,
            ),
          ),
        },
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
      recallMode: VALID_MEMORY_RECALL_MODES.has(memoryInput.recallMode as string)
        ? (memoryInput.recallMode as BrewvaConfig["memory"]["recallMode"])
        : defaults.memory.recallMode,
      externalRecall: {
        enabled: normalizeBoolean(
          memoryExternalRecallInput.enabled,
          defaults.memory.externalRecall.enabled,
        ),
        builtinProvider: VALID_MEMORY_EXTERNAL_RECALL_BUILTIN_PROVIDERS.has(
          memoryExternalRecallInput.builtinProvider as string,
        )
          ? (memoryExternalRecallInput.builtinProvider as BrewvaConfig["memory"]["externalRecall"]["builtinProvider"])
          : defaults.memory.externalRecall.builtinProvider,
        minInternalScore: normalizeUnitInterval(
          memoryExternalRecallInput.minInternalScore,
          defaults.memory.externalRecall.minInternalScore,
        ),
        queryTopK: normalizePositiveInteger(
          memoryExternalRecallInput.queryTopK,
          defaults.memory.externalRecall.queryTopK,
        ),
        injectedConfidence: normalizeUnitInterval(
          memoryExternalRecallInput.injectedConfidence,
          defaults.memory.externalRecall.injectedConfidence,
        ),
      },
      evolvesMode: VALID_MEMORY_EVOLVES_MODES.has(memoryInput.evolvesMode as string)
        ? (memoryInput.evolvesMode as BrewvaConfig["memory"]["evolvesMode"])
        : defaults.memory.evolvesMode,
      cognitive: {
        mode: VALID_MEMORY_COGNITIVE_MODES.has(memoryCognitiveInput.mode as string)
          ? (memoryCognitiveInput.mode as BrewvaConfig["memory"]["cognitive"]["mode"])
          : defaults.memory.cognitive.mode,
        maxTokensPerTurn: normalizeNonNegativeInteger(
          memoryCognitiveInput.maxTokensPerTurn,
          defaults.memory.cognitive.maxTokensPerTurn,
        ),
      },
      global: {
        enabled: normalizeBoolean(memoryGlobalInput.enabled, defaults.memory.global.enabled),
        minConfidence: normalizeUnitInterval(
          memoryGlobalInput.minConfidence,
          defaults.memory.global.minConfidence,
        ),
      },
    },
    security: {
      mode: normalizedSecurityMode,
      sanitizeContext: normalizeBoolean(
        securityInput.sanitizeContext,
        defaults.security.sanitizeContext,
      ),
      execution: {
        backend: normalizedExecutionBackend,
        enforceIsolation: normalizedExecutionEnforceIsolation,
        fallbackToHost: normalizedExecutionFallback,
        commandDenyList: normalizeLowercaseStringArray(
          securityExecutionInput.commandDenyList,
          defaults.security.execution.commandDenyList,
        ),
        sandbox: {
          serverUrl:
            normalizeOptionalNonEmptyString(securityExecutionSandboxInput.serverUrl) ??
            defaults.security.execution.sandbox.serverUrl,
          apiKey:
            normalizeOptionalNonEmptyString(securityExecutionSandboxInput.apiKey) ??
            defaults.security.execution.sandbox.apiKey,
          defaultImage:
            normalizeOptionalNonEmptyString(securityExecutionSandboxInput.defaultImage) ??
            defaults.security.execution.sandbox.defaultImage,
          memory: normalizePositiveInteger(
            securityExecutionSandboxInput.memory,
            defaults.security.execution.sandbox.memory,
          ),
          cpus: normalizePositiveInteger(
            securityExecutionSandboxInput.cpus,
            defaults.security.execution.sandbox.cpus,
          ),
          timeout: normalizePositiveInteger(
            securityExecutionSandboxInput.timeout,
            defaults.security.execution.sandbox.timeout,
          ),
        },
      },
    },
    schedule: {
      enabled: normalizeBoolean(scheduleInput.enabled, defaults.schedule.enabled),
      projectionPath: normalizeNonEmptyString(
        scheduleInput.projectionPath,
        defaults.schedule.projectionPath,
      ),
      leaseDurationMs: normalizePositiveInteger(
        scheduleInput.leaseDurationMs,
        defaults.schedule.leaseDurationMs,
      ),
      maxActiveIntentsPerSession: normalizePositiveInteger(
        scheduleInput.maxActiveIntentsPerSession,
        defaults.schedule.maxActiveIntentsPerSession,
      ),
      maxActiveIntentsGlobal: normalizePositiveInteger(
        scheduleInput.maxActiveIntentsGlobal,
        defaults.schedule.maxActiveIntentsGlobal,
      ),
      minIntervalMs: normalizePositiveInteger(
        scheduleInput.minIntervalMs,
        defaults.schedule.minIntervalMs,
      ),
      maxConsecutiveErrors: normalizePositiveInteger(
        scheduleInput.maxConsecutiveErrors,
        defaults.schedule.maxConsecutiveErrors,
      ),
      maxRecoveryCatchUps: normalizePositiveInteger(
        scheduleInput.maxRecoveryCatchUps,
        defaults.schedule.maxRecoveryCatchUps,
      ),
    },
    parallel: {
      enabled: normalizeBoolean(parallelInput.enabled, defaults.parallel.enabled),
      maxConcurrent: normalizePositiveInteger(
        parallelInput.maxConcurrent,
        defaults.parallel.maxConcurrent,
      ),
    },
    channels: {
      orchestration: {
        enabled: normalizeBoolean(
          channelsOrchestrationInput.enabled,
          defaults.channels.orchestration.enabled,
        ),
        scopeStrategy: VALID_CHANNEL_SCOPE_STRATEGIES.has(
          channelsOrchestrationInput.scopeStrategy as string,
        )
          ? (channelsOrchestrationInput.scopeStrategy as BrewvaConfig["channels"]["orchestration"]["scopeStrategy"])
          : defaults.channels.orchestration.scopeStrategy,
        aclModeWhenOwnersEmpty: VALID_CHANNEL_ACL_MODES.has(
          channelsOrchestrationInput.aclModeWhenOwnersEmpty as string,
        )
          ? (channelsOrchestrationInput.aclModeWhenOwnersEmpty as BrewvaConfig["channels"]["orchestration"]["aclModeWhenOwnersEmpty"])
          : defaults.channels.orchestration.aclModeWhenOwnersEmpty,
        owners: {
          telegram: normalizeStringArray(
            channelsOwnersInput.telegram,
            defaults.channels.orchestration.owners.telegram,
          ),
        },
        limits: {
          fanoutMaxAgents: normalizePositiveInteger(
            channelsLimitsInput.fanoutMaxAgents,
            defaults.channels.orchestration.limits.fanoutMaxAgents,
          ),
          maxDiscussionRounds: normalizePositiveInteger(
            channelsLimitsInput.maxDiscussionRounds,
            defaults.channels.orchestration.limits.maxDiscussionRounds,
          ),
          a2aMaxDepth: normalizePositiveInteger(
            channelsLimitsInput.a2aMaxDepth,
            defaults.channels.orchestration.limits.a2aMaxDepth,
          ),
          a2aMaxHops: normalizePositiveInteger(
            channelsLimitsInput.a2aMaxHops,
            defaults.channels.orchestration.limits.a2aMaxHops,
          ),
          maxLiveRuntimes: normalizePositiveInteger(
            channelsLimitsInput.maxLiveRuntimes,
            defaults.channels.orchestration.limits.maxLiveRuntimes,
          ),
          idleRuntimeTtlMs: normalizePositiveInteger(
            channelsLimitsInput.idleRuntimeTtlMs,
            defaults.channels.orchestration.limits.idleRuntimeTtlMs,
          ),
        },
      },
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
        level: VALID_EVENT_LEVELS.has(infrastructureEventsInput.level as string)
          ? (infrastructureEventsInput.level as BrewvaConfig["infrastructure"]["events"]["level"])
          : defaults.infrastructure.events.level,
      },
      contextBudget: {
        enabled: normalizeBoolean(contextBudgetInput.enabled, defaultContextBudget.enabled),
        profile: VALID_CONTEXT_BUDGET_PROFILES.has(contextBudgetInput.profile as string)
          ? (contextBudgetInput.profile as BrewvaConfig["infrastructure"]["contextBudget"]["profile"])
          : defaultContextBudget.profile,
        maxInjectionTokens: normalizePositiveInteger(
          contextBudgetInput.maxInjectionTokens,
          defaultContextBudget.maxInjectionTokens,
        ),
        compactionThresholdPercent: normalizedCompactionThresholdPercent,
        hardLimitPercent: normalizedHardLimitPercent,
        truncationStrategy: VALID_TRUNCATION_STRATEGIES.has(
          contextBudgetInput.truncationStrategy as string,
        )
          ? (contextBudgetInput.truncationStrategy as BrewvaConfig["infrastructure"]["contextBudget"]["truncationStrategy"])
          : defaultContextBudget.truncationStrategy,
        compactionInstructions: normalizeNonEmptyString(
          contextBudgetInput.compactionInstructions,
          defaultContextBudget.compactionInstructions,
        ),
        compaction: {
          minTurnsBetween: normalizeNonNegativeInteger(
            contextBudgetCompactionInput.minTurnsBetween,
            defaultContextCompaction.minTurnsBetween,
          ),
          minSecondsBetween: normalizeNonNegativeInteger(
            contextBudgetCompactionInput.minSecondsBetween,
            defaultContextCompaction.minSecondsBetween,
          ),
          pressureBypassPercent: normalizeUnitInterval(
            contextBudgetCompactionInput.pressureBypassPercent,
            defaultContextCompaction.pressureBypassPercent,
          ),
        },
        adaptiveZones: {
          enabled: normalizeBoolean(
            contextBudgetAdaptiveZonesInput.enabled,
            defaultContextAdaptiveZones.enabled,
          ),
          emaAlpha: normalizeUnitInterval(
            contextBudgetAdaptiveZonesInput.emaAlpha,
            defaultContextAdaptiveZones.emaAlpha,
          ),
          minTurnsBeforeAdapt: normalizeNonNegativeInteger(
            contextBudgetAdaptiveZonesInput.minTurnsBeforeAdapt,
            defaultContextAdaptiveZones.minTurnsBeforeAdapt,
          ),
          stepTokens: normalizePositiveInteger(
            contextBudgetAdaptiveZonesInput.stepTokens,
            defaultContextAdaptiveZones.stepTokens,
          ),
          maxShiftPerTurn: normalizeNonNegativeInteger(
            contextBudgetAdaptiveZonesInput.maxShiftPerTurn,
            defaultContextAdaptiveZones.maxShiftPerTurn,
          ),
          upshiftTruncationRatio: normalizeUnitInterval(
            contextBudgetAdaptiveZonesInput.upshiftTruncationRatio,
            defaultContextAdaptiveZones.upshiftTruncationRatio,
          ),
          downshiftIdleRatio: normalizeUnitInterval(
            contextBudgetAdaptiveZonesInput.downshiftIdleRatio,
            defaultContextAdaptiveZones.downshiftIdleRatio,
          ),
          retirement: normalizeContextRetirementPolicy(
            contextBudgetAdaptiveZonesInput.retirement,
            defaultContextAdaptiveZones.retirement,
          ),
        },
        floorUnmetPolicy: {
          enabled: normalizeBoolean(
            contextBudgetFloorUnmetPolicyInput.enabled,
            defaultContextFloorUnmetPolicy.enabled,
          ),
          relaxOrder: normalizeContextBudgetZoneOrder(
            contextBudgetFloorUnmetPolicyInput.relaxOrder,
            defaultContextFloorUnmetPolicy.relaxOrder,
          ),
          finalFallback: VALID_CONTEXT_FLOOR_UNMET_FALLBACKS.has(
            contextBudgetFloorUnmetPolicyInput.finalFallback as string,
          )
            ? (contextBudgetFloorUnmetPolicyInput.finalFallback as BrewvaConfig["infrastructure"]["contextBudget"]["floorUnmetPolicy"]["finalFallback"])
            : defaultContextFloorUnmetPolicy.finalFallback,
          requestCompaction: normalizeBoolean(
            contextBudgetFloorUnmetPolicyInput.requestCompaction,
            defaultContextFloorUnmetPolicy.requestCompaction,
          ),
        },
        stabilityMonitor: {
          enabled: normalizeBoolean(
            contextBudgetStabilityMonitorInput.enabled,
            defaultContextStabilityMonitor.enabled,
          ),
          consecutiveThreshold: normalizePositiveInteger(
            contextBudgetStabilityMonitorInput.consecutiveThreshold,
            defaultContextStabilityMonitor.consecutiveThreshold,
          ),
          retirement: normalizeContextRetirementPolicy(
            contextBudgetStabilityMonitorInput.retirement,
            defaultContextStabilityMonitor.retirement,
          ),
        },
        arena: {
          maxEntriesPerSession: normalizePositiveInteger(
            contextBudgetArenaInput.maxEntriesPerSession,
            defaultContextArena.maxEntriesPerSession,
          ),
          degradationPolicy: VALID_CONTEXT_ARENA_DEGRADATION_POLICIES.has(
            contextBudgetArenaInput.degradationPolicy as string,
          )
            ? (contextBudgetArenaInput.degradationPolicy as BrewvaConfig["infrastructure"]["contextBudget"]["arena"]["degradationPolicy"])
            : defaultContextArena.degradationPolicy,
          zones: {
            identity: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.identity,
              defaultContextArena.zones.identity,
            ),
            truth: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.truth,
              defaultContextArena.zones.truth,
            ),
            skills: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.skills,
              defaultContextArena.zones.skills,
            ),
            taskState: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.taskState,
              defaultContextArena.zones.taskState,
            ),
            toolFailures: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.toolFailures,
              defaultContextArena.zones.toolFailures,
            ),
            memoryWorking: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.memoryWorking,
              defaultContextArena.zones.memoryWorking,
            ),
            memoryRecall: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.memoryRecall,
              defaultContextArena.zones.memoryRecall,
            ),
            ragExternal: normalizeContextArenaZone(
              contextBudgetArenaZonesInput.ragExternal,
              defaultContextArena.zones.ragExternal,
            ),
          },
        },
      },
      toolFailureInjection: {
        enabled: normalizeBoolean(
          toolFailureInjectionInput.enabled,
          defaultToolFailureInjection.enabled,
        ),
        maxEntries: normalizePositiveInteger(
          toolFailureInjectionInput.maxEntries,
          defaultToolFailureInjection.maxEntries,
        ),
        maxOutputChars: normalizePositiveInteger(
          toolFailureInjectionInput.maxOutputChars,
          defaultToolFailureInjection.maxOutputChars,
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
        alertThresholdRatio: normalizeUnitInterval(
          costTrackingInput.alertThresholdRatio,
          defaults.infrastructure.costTracking.alertThresholdRatio,
        ),
        actionOnExceed: VALID_COST_ACTIONS.has(costTrackingInput.actionOnExceed as string)
          ? (costTrackingInput.actionOnExceed as BrewvaConfig["infrastructure"]["costTracking"]["actionOnExceed"])
          : defaults.infrastructure.costTracking.actionOnExceed,
      },
      turnWal: {
        enabled: normalizeBoolean(turnWalInput.enabled, defaults.infrastructure.turnWal.enabled),
        dir: normalizeNonEmptyString(turnWalInput.dir, defaults.infrastructure.turnWal.dir),
        defaultTtlMs: normalizePositiveInteger(
          turnWalInput.defaultTtlMs,
          defaults.infrastructure.turnWal.defaultTtlMs,
        ),
        maxRetries: normalizeNonNegativeInteger(
          turnWalInput.maxRetries,
          defaults.infrastructure.turnWal.maxRetries,
        ),
        compactAfterMs: normalizePositiveInteger(
          turnWalInput.compactAfterMs,
          defaults.infrastructure.turnWal.compactAfterMs,
        ),
        scheduleTurnTtlMs: normalizePositiveInteger(
          turnWalInput.scheduleTurnTtlMs,
          defaults.infrastructure.turnWal.scheduleTurnTtlMs,
        ),
      },
    },
  };
}
