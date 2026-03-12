import type {
  BrewvaConfig,
  SecurityEnforcementMode,
  SecurityEnforcementPreference,
} from "../types.js";

function toBaseSecurityPolicy(mode: BrewvaConfig["security"]["mode"]): EffectiveSecurityPolicy {
  // Denied effects are a hard contract boundary, so they remain enforced across all modes.
  if (mode === "strict") {
    return {
      enforceDeniedEffects: true,
      effectAuthorizationMode: "enforce",
      skillMaxTokensMode: "enforce",
      skillMaxToolCallsMode: "enforce",
      skillMaxParallelMode: "enforce",
    };
  }

  if (mode === "permissive") {
    return {
      enforceDeniedEffects: true,
      effectAuthorizationMode: "off",
      skillMaxTokensMode: "off",
      skillMaxToolCallsMode: "off",
      skillMaxParallelMode: "off",
    };
  }

  return {
    enforceDeniedEffects: true,
    effectAuthorizationMode: "warn",
    skillMaxTokensMode: "warn",
    skillMaxToolCallsMode: "warn",
    skillMaxParallelMode: "warn",
  };
}

function applyEnforcementPreference(
  fallback: SecurityEnforcementMode,
  preference: SecurityEnforcementPreference | undefined,
): SecurityEnforcementMode {
  if (preference === "off" || preference === "warn" || preference === "enforce") {
    return preference;
  }
  return fallback;
}

export interface EffectiveSecurityPolicy {
  enforceDeniedEffects: boolean;
  effectAuthorizationMode: SecurityEnforcementMode;
  skillMaxTokensMode: SecurityEnforcementMode;
  skillMaxToolCallsMode: SecurityEnforcementMode;
  skillMaxParallelMode: SecurityEnforcementMode;
}

export function resolveSecurityPolicy(
  input: BrewvaConfig["security"] | BrewvaConfig["security"]["mode"],
): EffectiveSecurityPolicy {
  const mode = typeof input === "string" ? input : input.mode;
  const base = toBaseSecurityPolicy(mode);
  if (typeof input === "string" || mode === "strict") {
    return base;
  }
  const enforcement = input.enforcement;
  if (!enforcement) {
    return base;
  }
  return {
    ...base,
    effectAuthorizationMode: applyEnforcementPreference(
      base.effectAuthorizationMode,
      enforcement.effectAuthorizationMode,
    ),
    skillMaxTokensMode: applyEnforcementPreference(
      base.skillMaxTokensMode,
      enforcement.skillMaxTokensMode,
    ),
    skillMaxToolCallsMode: applyEnforcementPreference(
      base.skillMaxToolCallsMode,
      enforcement.skillMaxToolCallsMode,
    ),
    skillMaxParallelMode: applyEnforcementPreference(
      base.skillMaxParallelMode,
      enforcement.skillMaxParallelMode,
    ),
  };
}
