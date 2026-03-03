import type {
  BrewvaConfig,
  SecurityEnforcementMode,
  SecurityEnforcementPreference,
} from "../types.js";

function toBaseSecurityPolicy(mode: BrewvaConfig["security"]["mode"]): EffectiveSecurityPolicy {
  // tools.denied is a hard contract boundary, so we enforce it consistently across all security modes.
  if (mode === "strict") {
    return {
      enforceDeniedTools: true,
      allowedToolsMode: "enforce",
      skillMaxTokensMode: "enforce",
      skillMaxToolCallsMode: "enforce",
      skillMaxParallelMode: "enforce",
      skillDispatchGateMode: "enforce",
    };
  }

  if (mode === "permissive") {
    return {
      enforceDeniedTools: true,
      allowedToolsMode: "off",
      skillMaxTokensMode: "off",
      skillMaxToolCallsMode: "off",
      skillMaxParallelMode: "off",
      skillDispatchGateMode: "off",
    };
  }

  return {
    enforceDeniedTools: true,
    allowedToolsMode: "warn",
    skillMaxTokensMode: "warn",
    skillMaxToolCallsMode: "warn",
    skillMaxParallelMode: "warn",
    skillDispatchGateMode: "warn",
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
  enforceDeniedTools: boolean;
  allowedToolsMode: SecurityEnforcementMode;
  skillMaxTokensMode: SecurityEnforcementMode;
  skillMaxToolCallsMode: SecurityEnforcementMode;
  skillMaxParallelMode: SecurityEnforcementMode;
  skillDispatchGateMode: SecurityEnforcementMode;
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
    allowedToolsMode: applyEnforcementPreference(
      base.allowedToolsMode,
      enforcement.allowedToolsMode,
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
    skillDispatchGateMode: applyEnforcementPreference(
      base.skillDispatchGateMode,
      enforcement.skillDispatchGateMode,
    ),
  };
}
