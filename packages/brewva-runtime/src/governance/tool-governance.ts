import type { ToolEffectClass, ToolGovernanceDescriptor, ToolGovernanceRisk } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";

function descriptor(input: {
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
}): ToolGovernanceDescriptor {
  return {
    effects: input.effects,
    defaultRisk: input.defaultRisk,
  };
}

function normalizeDescriptor(input: ToolGovernanceDescriptor): ToolGovernanceDescriptor {
  return {
    effects: [...new Set(input.effects)],
    defaultRisk: input.defaultRisk,
  };
}

function sameEffects(
  left: readonly ToolEffectClass[] | undefined,
  right: readonly ToolEffectClass[] | undefined,
): boolean {
  const leftValues = [...new Set(left ?? [])].toSorted();
  const rightValues = [...new Set(right ?? [])].toSorted();
  if (leftValues.length !== rightValues.length) {
    return false;
  }
  return leftValues.every((value, index) => value === rightValues[index]);
}

export const TOOL_GOVERNANCE_BY_NAME: Record<string, ToolGovernanceDescriptor> = {
  read: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  write: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  edit: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  grep: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  glob: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  read_spans: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  look_at: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  toc_document: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  toc_search: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  ast_grep_search: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  ast_grep_replace: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  lsp_diagnostics: descriptor({
    effects: ["workspace_read", "runtime_observe"],
    defaultRisk: "low",
  }),
  lsp_find_references: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  lsp_goto_definition: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  lsp_prepare_rename: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  lsp_rename: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  lsp_symbols: descriptor({
    effects: ["workspace_read"],
    defaultRisk: "low",
  }),
  output_search: descriptor({
    effects: ["workspace_read", "runtime_observe"],
    defaultRisk: "low",
  }),
  ledger_query: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  tape_handoff: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  tape_info: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  tape_search: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  resource_lease: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  session_compact: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "medium",
  }),
  cost_view: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  obs_query: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  obs_slo_assert: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  obs_snapshot: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  exec: descriptor({
    effects: ["local_exec"],
    defaultRisk: "high",
  }),
  process: descriptor({
    effects: ["local_exec"],
    defaultRisk: "medium",
  }),
  schedule_intent: descriptor({
    effects: ["schedule_mutation"],
    defaultRisk: "high",
  }),
  skill_load: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  skill_complete: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  skill_chain_control: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  task_view_state: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
  task_set_spec: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_add_item: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_update_item: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_record_blocker: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  task_resolve_blocker: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  cognition_note: descriptor({
    effects: ["memory_write"],
    defaultRisk: "medium",
  }),
  rollback_last_patch: descriptor({
    effects: ["workspace_write"],
    defaultRisk: "high",
  }),
  agent_send: descriptor({
    effects: ["external_network", "external_side_effect"],
    defaultRisk: "high",
  }),
  agent_broadcast: descriptor({
    effects: ["external_network", "external_side_effect"],
    defaultRisk: "high",
  }),
  agent_list: descriptor({
    effects: ["runtime_observe"],
    defaultRisk: "low",
  }),
};

const TOOL_NAME_EFFECT_HINTS: Array<{
  match: RegExp;
  descriptor: ToolGovernanceDescriptor;
}> = [
  {
    match: /(^|_)(read|view|search|grep|find|inspect|query|list|show|diag|symbol)(_|$)/u,
    descriptor: descriptor({
      effects: ["workspace_read"],
      defaultRisk: "low",
    }),
  },
  {
    match: /(^|_)(edit|write|patch|rename|replace|apply)(_|$)/u,
    descriptor: descriptor({
      effects: ["workspace_write"],
      defaultRisk: "high",
    }),
  },
  {
    match: /(^|_)(exec|shell|bash|command)(_|$)/u,
    descriptor: descriptor({
      effects: ["local_exec"],
      defaultRisk: "high",
    }),
  },
];

const CUSTOM_TOOL_GOVERNANCE_BY_NAME = new Map<string, ToolGovernanceDescriptor>();

export function registerToolGovernanceDescriptor(
  toolName: string,
  input: ToolGovernanceDescriptor,
): void {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    throw new Error("tool governance descriptor requires a non-empty tool name");
  }
  if (!Array.isArray(input.effects) || input.effects.length === 0) {
    throw new Error(`tool governance descriptor '${normalized}' requires at least one effect`);
  }
  CUSTOM_TOOL_GOVERNANCE_BY_NAME.set(normalized, normalizeDescriptor(input));
}

export function unregisterToolGovernanceDescriptor(toolName: string): void {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return;
  CUSTOM_TOOL_GOVERNANCE_BY_NAME.delete(normalized);
}

export function getExactToolGovernanceDescriptor(
  toolName: string,
): ToolGovernanceDescriptor | undefined {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return undefined;
  return TOOL_GOVERNANCE_BY_NAME[normalized];
}

export function sameToolGovernanceDescriptor(
  left: ToolGovernanceDescriptor | undefined,
  right: ToolGovernanceDescriptor | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.defaultRisk === right.defaultRisk && sameEffects(left.effects, right.effects);
}

export function getToolGovernanceDescriptor(
  toolName: string,
): ToolGovernanceDescriptor | undefined {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return undefined;
  const custom = CUSTOM_TOOL_GOVERNANCE_BY_NAME.get(normalized);
  if (custom) {
    return custom;
  }
  const exact = getExactToolGovernanceDescriptor(normalized);
  if (exact) {
    return exact;
  }
  const hinted = TOOL_NAME_EFFECT_HINTS.find((entry) => entry.match.test(normalized));
  return hinted?.descriptor;
}
