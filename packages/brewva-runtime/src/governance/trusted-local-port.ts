import type { ToolEffectClass } from "../types.js";
import type { GovernancePort } from "./port.js";

export interface TrustedLocalGovernancePortOptions {
  allowLocalExec?: boolean;
  allowScheduleMutation?: boolean;
  allowExternalEffects?: boolean;
}

function hasAnyEffect(
  effects: readonly ToolEffectClass[],
  expected: readonly ToolEffectClass[],
): boolean {
  return expected.some((effect) => effects.includes(effect));
}

export function createTrustedLocalGovernancePort(
  options: TrustedLocalGovernancePortOptions = {},
): GovernancePort {
  const allowLocalExec = options.allowLocalExec ?? true;
  const allowScheduleMutation = options.allowScheduleMutation ?? true;
  const allowExternalEffects = options.allowExternalEffects ?? true;

  return {
    authorizeEffectCommitment(input) {
      const toolName = input.proposal.payload.toolName.trim() || input.proposal.subject.trim();
      const effects = [...new Set(input.proposal.payload.effects)];

      if (hasAnyEffect(effects, ["external_network", "external_side_effect"])) {
        if (allowExternalEffects) {
          return {
            decision: "accept",
            policyBasis: ["trusted_local_host_governance", "trusted_local_host_external_effect"],
            reasons: [`effect_commitment_host_authorized:${toolName}`],
          };
        }
        return {
          decision: "defer",
          policyBasis: [
            "trusted_local_host_governance",
            "trusted_local_host_external_review_required",
          ],
          reasons: [`effect_commitment_requires_governance_port:${toolName}`],
        };
      }

      if (effects.includes("schedule_mutation")) {
        if (allowScheduleMutation) {
          return {
            decision: "accept",
            policyBasis: ["trusted_local_host_governance", "trusted_local_host_schedule_mutation"],
            reasons: [`effect_commitment_host_authorized:${toolName}`],
          };
        }
        return {
          decision: "defer",
          policyBasis: [
            "trusted_local_host_governance",
            "trusted_local_host_schedule_review_required",
          ],
          reasons: [`effect_commitment_requires_governance_port:${toolName}`],
        };
      }

      if (effects.includes("local_exec")) {
        if (allowLocalExec) {
          return {
            decision: "accept",
            policyBasis: ["trusted_local_host_governance", "trusted_local_host_local_exec"],
            reasons: [`effect_commitment_host_authorized:${toolName}`],
          };
        }
        return {
          decision: "defer",
          policyBasis: [
            "trusted_local_host_governance",
            "trusted_local_host_local_exec_review_required",
          ],
          reasons: [`effect_commitment_requires_governance_port:${toolName}`],
        };
      }

      return {
        decision: "defer",
        policyBasis: [
          "trusted_local_host_governance",
          "trusted_local_host_unknown_effect_review_required",
        ],
        reasons: [`effect_commitment_requires_governance_port:${toolName}`],
      };
    },
  };
}
