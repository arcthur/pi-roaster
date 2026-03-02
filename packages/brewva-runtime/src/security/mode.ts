import type { BrewvaConfig } from "../types.js";

export type PolicyEnforcementMode = "off" | "warn" | "enforce";

export interface EffectiveSecurityPolicy {
  enforceDeniedTools: boolean;
  allowedToolsMode: PolicyEnforcementMode;
  skillMaxTokensMode: PolicyEnforcementMode;
  skillMaxToolCallsMode: PolicyEnforcementMode;
  skillMaxParallelMode: PolicyEnforcementMode;
  skillDispatchGateMode: PolicyEnforcementMode;
}

export function resolveSecurityPolicy(
  mode: BrewvaConfig["security"]["mode"],
): EffectiveSecurityPolicy {
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
