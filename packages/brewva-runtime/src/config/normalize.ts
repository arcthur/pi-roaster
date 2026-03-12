import type { BrewvaConfig, SkillRoutingScope, VerificationLevel } from "../types.js";

const VALID_COST_ACTIONS = new Set(["warn", "block_tools"]);
const VALID_SECURITY_MODES = new Set(["permissive", "standard", "strict"]);
const VALID_SECURITY_ENFORCEMENT_MODES = new Set(["off", "warn", "enforce", "inherit"]);
const VALID_EXECUTION_BACKENDS = new Set(["host", "sandbox", "best_available"]);
const VALID_EVENT_LEVELS = new Set(["audit", "ops", "debug"]);
const VALID_VERIFICATION_LEVELS = new Set<VerificationLevel>(["quick", "standard", "strict"]);
const VALID_CHANNEL_SCOPE_STRATEGIES = new Set(["chat", "thread"]);
const VALID_CHANNEL_ACL_MODES = new Set(["open", "closed"]);
const VALID_SKILL_CASCADE_MODES = new Set(["off", "assist", "auto"]);
const VALID_SKILL_CASCADE_SOURCES = new Set(["dispatch", "explicit"]);
const VALID_SKILL_ROUTING_SCOPES = new Set(["core", "domain", "operator", "meta"]);

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

function normalizeStrictStringEnum<T extends string>(
  value: unknown,
  fallback: T,
  validSet: Set<string>,
  fieldPath: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new Error(
      `Invalid config value for ${fieldPath}: expected one of [${[...validSet].join(", ")}], received non-string.`,
    );
  }
  const normalized = value.trim();
  if (validSet.has(normalized)) {
    return normalized as T;
  }
  throw new Error(
    `Invalid config value for ${fieldPath}: expected one of [${[...validSet].join(", ")}], received "${value}".`,
  );
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

function normalizeSkillCascadeSourceList(
  value: unknown,
  fallback: BrewvaConfig["skills"]["cascade"]["enabledSources"],
): BrewvaConfig["skills"]["cascade"]["enabledSources"] {
  if (!Array.isArray(value)) return [...fallback];
  const out: BrewvaConfig["skills"]["cascade"]["enabledSources"] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VALID_SKILL_CASCADE_SOURCES.has(entry)) continue;
    const normalizedEntry = entry as BrewvaConfig["skills"]["cascade"]["enabledSources"][number];
    if (out.includes(normalizedEntry)) continue;
    out.push(normalizedEntry);
  }
  return out.length > 0 ? out : [...fallback];
}

function normalizeSkillRoutingScopeList(
  value: unknown,
  fallback: SkillRoutingScope[],
): SkillRoutingScope[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: SkillRoutingScope[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VALID_SKILL_ROUTING_SCOPES.has(entry)) continue;
    const normalizedEntry = entry as SkillRoutingScope;
    if (out.includes(normalizedEntry)) continue;
    out.push(normalizedEntry);
  }
  return out.length > 0 ? out : [...fallback];
}

function normalizeUiConfig(uiInput: AnyRecord, defaults: BrewvaConfig["ui"]): BrewvaConfig["ui"] {
  return {
    quietStartup: normalizeBoolean(uiInput.quietStartup, defaults.quietStartup),
  };
}

function normalizeSkillsConfig(
  skillsInput: AnyRecord,
  defaults: BrewvaConfig["skills"],
): BrewvaConfig["skills"] {
  const skillsRoutingInput = isRecord(skillsInput.routing) ? skillsInput.routing : {};
  const skillsCascadeInput = isRecord(skillsInput.cascade) ? skillsInput.cascade : {};
  const normalizedCascadeSourcePriority = normalizeSkillCascadeSourceList(
    skillsCascadeInput.sourcePriority,
    defaults.cascade.sourcePriority,
  );
  const normalizedCascadeEnabledSources = normalizeSkillCascadeSourceList(
    skillsCascadeInput.enabledSources,
    defaults.cascade.enabledSources,
  );
  const normalizedRoutingScopes = normalizeSkillRoutingScopeList(
    skillsRoutingInput.scopes,
    defaults.routing.scopes,
  );
  const effectiveCascadeSourcePriority = [
    ...normalizedCascadeSourcePriority.filter((source) =>
      normalizedCascadeEnabledSources.includes(source),
    ),
    ...normalizedCascadeEnabledSources.filter(
      (source) => !normalizedCascadeSourcePriority.includes(source),
    ),
  ] as BrewvaConfig["skills"]["cascade"]["sourcePriority"];

  return {
    roots: normalizeStringArray(skillsInput.roots, defaults.roots ?? []),
    disabled: normalizeStringArray(skillsInput.disabled, defaults.disabled),
    overrides: normalizeSkillOverrides(skillsInput.overrides, defaults.overrides),
    routing: {
      enabled: normalizeBoolean(skillsRoutingInput.enabled, defaults.routing.enabled),
      scopes: normalizedRoutingScopes,
    },
    cascade: {
      mode: normalizeStrictStringEnum(
        skillsCascadeInput.mode,
        defaults.cascade.mode,
        VALID_SKILL_CASCADE_MODES,
        "skills.cascade.mode",
      ),
      enabledSources: normalizedCascadeEnabledSources,
      sourcePriority: effectiveCascadeSourcePriority,
      maxStepsPerRun: normalizePositiveInteger(
        skillsCascadeInput.maxStepsPerRun,
        defaults.cascade.maxStepsPerRun,
      ),
    },
  };
}

function normalizeVerificationConfig(
  verificationInput: AnyRecord,
  defaults: BrewvaConfig["verification"],
): BrewvaConfig["verification"] {
  const verificationChecksInput = isRecord(verificationInput.checks)
    ? verificationInput.checks
    : {};

  return {
    defaultLevel: normalizeVerificationLevel(verificationInput.defaultLevel, defaults.defaultLevel),
    checks: {
      quick: normalizeStringArray(verificationChecksInput.quick, defaults.checks.quick),
      standard: normalizeStringArray(verificationChecksInput.standard, defaults.checks.standard),
      strict: normalizeStringArray(verificationChecksInput.strict, defaults.checks.strict),
    },
    commands: normalizeStringRecord(verificationInput.commands, defaults.commands),
  };
}

function normalizeProjectionConfig(
  projectionInput: AnyRecord,
  defaults: BrewvaConfig["projection"],
): BrewvaConfig["projection"] {
  return {
    enabled: normalizeBoolean(projectionInput.enabled, defaults.enabled),
    dir: normalizeNonEmptyString(projectionInput.dir, defaults.dir),
    workingFile: normalizeNonEmptyString(projectionInput.workingFile, defaults.workingFile),
    maxWorkingChars: normalizePositiveInteger(
      projectionInput.maxWorkingChars,
      defaults.maxWorkingChars,
    ),
  };
}

function normalizeSecurityConfig(
  securityInput: AnyRecord,
  defaults: BrewvaConfig["security"],
): BrewvaConfig["security"] {
  const securityEnforcementInput = isRecord(securityInput.enforcement)
    ? securityInput.enforcement
    : {};
  const securityExecutionInput = isRecord(securityInput.execution) ? securityInput.execution : {};
  const securityExecutionSandboxInput = isRecord(securityExecutionInput.sandbox)
    ? securityExecutionInput.sandbox
    : {};
  const normalizedSecurityMode = VALID_SECURITY_MODES.has(securityInput.mode as string)
    ? (securityInput.mode as BrewvaConfig["security"]["mode"])
    : defaults.mode;
  const normalizedExecutionEnforceIsolation = normalizeBoolean(
    securityExecutionInput.enforceIsolation,
    defaults.execution.enforceIsolation,
  );
  const configuredExecutionBackend = VALID_EXECUTION_BACKENDS.has(
    securityExecutionInput.backend as string,
  )
    ? (securityExecutionInput.backend as BrewvaConfig["security"]["execution"]["backend"])
    : defaults.execution.backend;
  const normalizedExecutionBackend = normalizedExecutionEnforceIsolation
    ? "sandbox"
    : normalizedSecurityMode === "strict"
      ? "sandbox"
      : configuredExecutionBackend;
  const normalizedExecutionFallback =
    normalizedExecutionEnforceIsolation || normalizedSecurityMode === "strict"
      ? false
      : normalizeBoolean(securityExecutionInput.fallbackToHost, defaults.execution.fallbackToHost);

  return {
    mode: normalizedSecurityMode,
    sanitizeContext: normalizeBoolean(securityInput.sanitizeContext, defaults.sanitizeContext),
    enforcement: {
      effectAuthorizationMode: normalizeStrictStringEnum(
        securityEnforcementInput.effectAuthorizationMode,
        defaults.enforcement.effectAuthorizationMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.effectAuthorizationMode",
      ),
      skillMaxTokensMode: normalizeStrictStringEnum(
        securityEnforcementInput.skillMaxTokensMode,
        defaults.enforcement.skillMaxTokensMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.skillMaxTokensMode",
      ),
      skillMaxToolCallsMode: normalizeStrictStringEnum(
        securityEnforcementInput.skillMaxToolCallsMode,
        defaults.enforcement.skillMaxToolCallsMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.skillMaxToolCallsMode",
      ),
      skillMaxParallelMode: normalizeStrictStringEnum(
        securityEnforcementInput.skillMaxParallelMode,
        defaults.enforcement.skillMaxParallelMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.skillMaxParallelMode",
      ),
    },
    execution: {
      backend: normalizedExecutionBackend,
      enforceIsolation: normalizedExecutionEnforceIsolation,
      fallbackToHost: normalizedExecutionFallback,
      commandDenyList: normalizeLowercaseStringArray(
        securityExecutionInput.commandDenyList,
        defaults.execution.commandDenyList,
      ),
      sandbox: {
        serverUrl:
          normalizeOptionalNonEmptyString(securityExecutionSandboxInput.serverUrl) ??
          defaults.execution.sandbox.serverUrl,
        apiKey:
          normalizeOptionalNonEmptyString(securityExecutionSandboxInput.apiKey) ??
          defaults.execution.sandbox.apiKey,
        defaultImage:
          normalizeOptionalNonEmptyString(securityExecutionSandboxInput.defaultImage) ??
          defaults.execution.sandbox.defaultImage,
        memory: normalizePositiveInteger(
          securityExecutionSandboxInput.memory,
          defaults.execution.sandbox.memory,
        ),
        cpus: normalizePositiveInteger(
          securityExecutionSandboxInput.cpus,
          defaults.execution.sandbox.cpus,
        ),
        timeout: normalizePositiveInteger(
          securityExecutionSandboxInput.timeout,
          defaults.execution.sandbox.timeout,
        ),
      },
    },
  };
}

function normalizeScheduleConfig(
  scheduleInput: AnyRecord,
  defaults: BrewvaConfig["schedule"],
): BrewvaConfig["schedule"] {
  return {
    enabled: normalizeBoolean(scheduleInput.enabled, defaults.enabled),
    projectionPath: normalizeNonEmptyString(scheduleInput.projectionPath, defaults.projectionPath),
    leaseDurationMs: normalizePositiveInteger(
      scheduleInput.leaseDurationMs,
      defaults.leaseDurationMs,
    ),
    maxActiveIntentsPerSession: normalizePositiveInteger(
      scheduleInput.maxActiveIntentsPerSession,
      defaults.maxActiveIntentsPerSession,
    ),
    maxActiveIntentsGlobal: normalizePositiveInteger(
      scheduleInput.maxActiveIntentsGlobal,
      defaults.maxActiveIntentsGlobal,
    ),
    minIntervalMs: normalizePositiveInteger(scheduleInput.minIntervalMs, defaults.minIntervalMs),
    maxConsecutiveErrors: normalizePositiveInteger(
      scheduleInput.maxConsecutiveErrors,
      defaults.maxConsecutiveErrors,
    ),
    maxRecoveryCatchUps: normalizePositiveInteger(
      scheduleInput.maxRecoveryCatchUps,
      defaults.maxRecoveryCatchUps,
    ),
  };
}

function normalizeChannelsConfig(
  channelsInput: AnyRecord,
  defaults: BrewvaConfig["channels"],
): BrewvaConfig["channels"] {
  const channelsOrchestrationInput = isRecord(channelsInput.orchestration)
    ? channelsInput.orchestration
    : {};
  const channelsOwnersInput = isRecord(channelsOrchestrationInput.owners)
    ? channelsOrchestrationInput.owners
    : {};
  const channelsLimitsInput = isRecord(channelsOrchestrationInput.limits)
    ? channelsOrchestrationInput.limits
    : {};

  return {
    orchestration: {
      enabled: normalizeBoolean(channelsOrchestrationInput.enabled, defaults.orchestration.enabled),
      scopeStrategy: VALID_CHANNEL_SCOPE_STRATEGIES.has(
        channelsOrchestrationInput.scopeStrategy as string,
      )
        ? (channelsOrchestrationInput.scopeStrategy as BrewvaConfig["channels"]["orchestration"]["scopeStrategy"])
        : defaults.orchestration.scopeStrategy,
      aclModeWhenOwnersEmpty: VALID_CHANNEL_ACL_MODES.has(
        channelsOrchestrationInput.aclModeWhenOwnersEmpty as string,
      )
        ? (channelsOrchestrationInput.aclModeWhenOwnersEmpty as BrewvaConfig["channels"]["orchestration"]["aclModeWhenOwnersEmpty"])
        : defaults.orchestration.aclModeWhenOwnersEmpty,
      owners: {
        telegram: normalizeStringArray(
          channelsOwnersInput.telegram,
          defaults.orchestration.owners.telegram,
        ),
      },
      limits: {
        fanoutMaxAgents: normalizePositiveInteger(
          channelsLimitsInput.fanoutMaxAgents,
          defaults.orchestration.limits.fanoutMaxAgents,
        ),
        maxDiscussionRounds: normalizePositiveInteger(
          channelsLimitsInput.maxDiscussionRounds,
          defaults.orchestration.limits.maxDiscussionRounds,
        ),
        a2aMaxDepth: normalizePositiveInteger(
          channelsLimitsInput.a2aMaxDepth,
          defaults.orchestration.limits.a2aMaxDepth,
        ),
        a2aMaxHops: normalizePositiveInteger(
          channelsLimitsInput.a2aMaxHops,
          defaults.orchestration.limits.a2aMaxHops,
        ),
        maxLiveRuntimes: normalizePositiveInteger(
          channelsLimitsInput.maxLiveRuntimes,
          defaults.orchestration.limits.maxLiveRuntimes,
        ),
        idleRuntimeTtlMs: normalizePositiveInteger(
          channelsLimitsInput.idleRuntimeTtlMs,
          defaults.orchestration.limits.idleRuntimeTtlMs,
        ),
      },
    },
  };
}

function normalizeInfrastructureConfig(
  infrastructureInput: AnyRecord,
  defaults: BrewvaConfig["infrastructure"],
): BrewvaConfig["infrastructure"] {
  const infrastructureEventsInput = isRecord(infrastructureInput.events)
    ? infrastructureInput.events
    : {};
  const contextBudgetInput = isRecord(infrastructureInput.contextBudget)
    ? infrastructureInput.contextBudget
    : {};
  const contextBudgetCompactionInput = isRecord(contextBudgetInput.compaction)
    ? contextBudgetInput.compaction
    : {};
  const contextBudgetArenaInput = isRecord(contextBudgetInput.arena)
    ? contextBudgetInput.arena
    : {};
  const toolFailureInjectionInput = isRecord(infrastructureInput.toolFailureInjection)
    ? infrastructureInput.toolFailureInjection
    : {};
  const toolOutputDistillationInjectionInput = isRecord(
    infrastructureInput.toolOutputDistillationInjection,
  )
    ? infrastructureInput.toolOutputDistillationInjection
    : {};
  const interruptRecoveryInput = isRecord(infrastructureInput.interruptRecovery)
    ? infrastructureInput.interruptRecovery
    : {};
  const costTrackingInput = isRecord(infrastructureInput.costTracking)
    ? infrastructureInput.costTracking
    : {};
  const turnWalInput = isRecord(infrastructureInput.turnWal) ? infrastructureInput.turnWal : {};
  const defaultContextBudget = defaults.contextBudget;
  const defaultContextCompaction = defaultContextBudget.compaction;
  const defaultContextArena = defaultContextBudget.arena;
  const defaultToolFailureInjection = defaults.toolFailureInjection;
  const defaultToolOutputDistillationInjection = defaults.toolOutputDistillationInjection;
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
    events: {
      enabled: normalizeBoolean(infrastructureEventsInput.enabled, defaults.events.enabled),
      dir: normalizeNonEmptyString(infrastructureEventsInput.dir, defaults.events.dir),
      level: VALID_EVENT_LEVELS.has(infrastructureEventsInput.level as string)
        ? (infrastructureEventsInput.level as BrewvaConfig["infrastructure"]["events"]["level"])
        : defaults.events.level,
    },
    contextBudget: {
      enabled: normalizeBoolean(contextBudgetInput.enabled, defaultContextBudget.enabled),
      maxInjectionTokens: normalizePositiveInteger(
        contextBudgetInput.maxInjectionTokens,
        defaultContextBudget.maxInjectionTokens,
      ),
      compactionThresholdPercent: normalizedCompactionThresholdPercent,
      hardLimitPercent: normalizedHardLimitPercent,
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
      arena: {
        maxEntriesPerSession: normalizePositiveInteger(
          contextBudgetArenaInput.maxEntriesPerSession,
          defaultContextArena.maxEntriesPerSession,
        ),
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
    toolOutputDistillationInjection: {
      enabled: normalizeBoolean(
        toolOutputDistillationInjectionInput.enabled,
        defaultToolOutputDistillationInjection.enabled,
      ),
      maxEntries: normalizePositiveInteger(
        toolOutputDistillationInjectionInput.maxEntries,
        defaultToolOutputDistillationInjection.maxEntries,
      ),
      maxOutputChars: normalizePositiveInteger(
        toolOutputDistillationInjectionInput.maxOutputChars,
        defaultToolOutputDistillationInjection.maxOutputChars,
      ),
    },
    interruptRecovery: {
      enabled: normalizeBoolean(interruptRecoveryInput.enabled, defaults.interruptRecovery.enabled),
      gracefulTimeoutMs: normalizePositiveInteger(
        interruptRecoveryInput.gracefulTimeoutMs,
        defaults.interruptRecovery.gracefulTimeoutMs,
      ),
    },
    costTracking: {
      enabled: normalizeBoolean(costTrackingInput.enabled, defaults.costTracking.enabled),
      maxCostUsdPerSession: normalizeNonNegativeNumber(
        costTrackingInput.maxCostUsdPerSession,
        defaults.costTracking.maxCostUsdPerSession,
      ),
      alertThresholdRatio: normalizeUnitInterval(
        costTrackingInput.alertThresholdRatio,
        defaults.costTracking.alertThresholdRatio,
      ),
      actionOnExceed: VALID_COST_ACTIONS.has(costTrackingInput.actionOnExceed as string)
        ? (costTrackingInput.actionOnExceed as BrewvaConfig["infrastructure"]["costTracking"]["actionOnExceed"])
        : defaults.costTracking.actionOnExceed,
    },
    turnWal: {
      enabled: normalizeBoolean(turnWalInput.enabled, defaults.turnWal.enabled),
      dir: normalizeNonEmptyString(turnWalInput.dir, defaults.turnWal.dir),
      defaultTtlMs: normalizePositiveInteger(
        turnWalInput.defaultTtlMs,
        defaults.turnWal.defaultTtlMs,
      ),
      maxRetries: normalizeNonNegativeInteger(turnWalInput.maxRetries, defaults.turnWal.maxRetries),
      compactAfterMs: normalizePositiveInteger(
        turnWalInput.compactAfterMs,
        defaults.turnWal.compactAfterMs,
      ),
      scheduleTurnTtlMs: normalizePositiveInteger(
        turnWalInput.scheduleTurnTtlMs,
        defaults.turnWal.scheduleTurnTtlMs,
      ),
    },
  };
}

export function normalizeBrewvaConfig(config: unknown, defaults: BrewvaConfig): BrewvaConfig {
  const input = isRecord(config) ? config : {};
  const uiInput = isRecord(input.ui) ? input.ui : {};
  const skillsInput = isRecord(input.skills) ? input.skills : {};
  const verificationInput = isRecord(input.verification) ? input.verification : {};
  const ledgerInput = isRecord(input.ledger) ? input.ledger : {};
  const tapeInput = isRecord(input.tape) ? input.tape : {};
  const projectionInput = isRecord(input.projection) ? input.projection : {};
  const securityInput = isRecord(input.security) ? input.security : {};
  const scheduleInput = isRecord(input.schedule) ? input.schedule : {};
  const parallelInput = isRecord(input.parallel) ? input.parallel : {};
  const channelsInput = isRecord(input.channels) ? input.channels : {};
  const infrastructureInput = isRecord(input.infrastructure) ? input.infrastructure : {};

  return {
    ui: normalizeUiConfig(uiInput, defaults.ui),
    skills: normalizeSkillsConfig(skillsInput, defaults.skills),
    verification: normalizeVerificationConfig(verificationInput, defaults.verification),
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
    projection: normalizeProjectionConfig(projectionInput, defaults.projection),
    security: normalizeSecurityConfig(securityInput, defaults.security),
    schedule: normalizeScheduleConfig(scheduleInput, defaults.schedule),
    parallel: {
      enabled: normalizeBoolean(parallelInput.enabled, defaults.parallel.enabled),
      maxConcurrent: normalizePositiveInteger(
        parallelInput.maxConcurrent,
        defaults.parallel.maxConcurrent,
      ),
      maxTotalPerSession: normalizePositiveInteger(
        parallelInput.maxTotalPerSession,
        defaults.parallel.maxTotalPerSession,
      ),
    },
    channels: normalizeChannelsConfig(channelsInput, defaults.channels),
    infrastructure: normalizeInfrastructureConfig(infrastructureInput, defaults.infrastructure),
  };
}
