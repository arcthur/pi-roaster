import type { SkillContract, ToolAccessResult } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";

export interface ToolPolicyOptions {
  enforceDeniedTools: boolean;
  allowedToolsMode: "off" | "warn" | "enforce";
  alwaysAllowedTools?: string[];
}

function normalizeToolList(tools: string[]): string[] {
  return tools.map((tool) => normalizeToolName(tool)).filter((tool) => tool.length > 0);
}

export function checkToolAccess(
  contract: SkillContract | undefined,
  toolName: string,
  options: ToolPolicyOptions,
): ToolAccessResult {
  if (!contract) return { allowed: true };

  const normalized = normalizeToolName(toolName);
  if (!normalized) return { allowed: true };

  const alwaysAllowed = new Set(normalizeToolList(options.alwaysAllowedTools ?? []));
  if (alwaysAllowed.has(normalized)) {
    return { allowed: true };
  }

  const denied = new Set(normalizeToolList(contract.tools.denied));
  const effectiveDenied = options.enforceDeniedTools ? denied : new Set<string>();
  if (options.enforceDeniedTools && effectiveDenied.has(normalized)) {
    return {
      allowed: false,
      reason: `Tool '${normalized}' is denied by skill '${contract.name}'.`,
    };
  }

  if (options.allowedToolsMode === "off") {
    return { allowed: true };
  }

  const required = normalizeToolList(contract.tools.required);
  const optional = normalizeToolList(contract.tools.optional);
  const allowlist = new Set(
    [...required, ...optional].filter((tool) => !effectiveDenied.has(tool)),
  );

  // Treat an empty allowlist as "no allowlist" to avoid accidental total block.
  if (allowlist.size === 0) {
    return { allowed: true };
  }

  if (allowlist.has(normalized)) {
    return { allowed: true };
  }

  const reason = `Tool '${normalized}' is not allowed by skill '${contract.name}' (allowedToolsMode=${options.allowedToolsMode}).`;
  if (options.allowedToolsMode === "warn") {
    return { allowed: true, warning: reason };
  }

  return { allowed: false, reason };
}
