import {
  getToolGovernanceDescriptor,
  type ToolEffectClass,
  type ToolInvocationPosture,
} from "@brewva/brewva-runtime";
import { getBrewvaToolSurface, type BrewvaToolSurface } from "@brewva/brewva-tools";

interface ToolLike {
  name: string;
  description: string;
  parameters?: unknown;
}

export type CapabilitySurface = BrewvaToolSurface | "external";
export type CapabilityHintId = "load_or_accept_skill" | "operator_profile_available";
export type CapabilityPolicyId =
  | "surface_visibility"
  | "posture_boundaries"
  | "explicit_request_expansion";
export type CapabilityRenderMode = "full" | "compact";
export type CapabilityRenderedBlockKind = "summary" | "inventory" | "policy" | "detail" | "missing";
export type CapabilityRenderedBlockPriority = "essential" | "requested" | "optional";

interface CapabilityEntry {
  name: string;
  description: string;
  parameterKeys: string[];
  visible: boolean;
  governance: boolean;
  surface: CapabilitySurface;
  posture: ToolInvocationPosture;
  effects: ToolEffectClass[];
}

export interface CapabilityAccessDecision {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export interface BuildCapabilityViewInput {
  prompt: string;
  allTools: ToolLike[];
  activeToolNames: string[];
  resolveAccess?: (toolName: string) => CapabilityAccessDecision;
  maxRequestedDetails?: number;
}

export interface CapabilityVisibilityInventory {
  availableTotal: number;
  visibleNames: string[];
  visibleByPosture: Record<ToolInvocationPosture, number>;
  hiddenBySurface: Record<CapabilitySurface, number>;
  hints: CapabilityHintId[];
}

export interface CapabilityViewPolicy {
  id: CapabilityPolicyId;
}

export interface CapabilityDetail {
  name: string;
  description: string;
  parameterKeys: string[];
  surface: CapabilitySurface;
  posture: ToolInvocationPosture;
  effects: ToolEffectClass[];
  visibleNow: boolean;
  governance: boolean;
  access?: CapabilityAccessDecision;
}

export interface BuildCapabilityViewResult {
  inventory: CapabilityVisibilityInventory;
  policies: CapabilityViewPolicy[];
  requested: string[];
  details: CapabilityDetail[];
  missing: string[];
}

export interface RenderCapabilityViewInput {
  capabilityView: BuildCapabilityViewResult;
  mode?: CapabilityRenderMode;
  includeInventory?: boolean;
  maxVisibleNames?: number;
}

export interface CapabilityRenderedBlock {
  id: string;
  kind: CapabilityRenderedBlockKind;
  priority: CapabilityRenderedBlockPriority;
  content: string;
  compactContent?: string;
}

const GOVERNANCE_TOOL_NAMES = new Set<string>([
  "session_compact",
  "resource_lease",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "skill_complete",
  "skill_chain_control",
  "task_set_spec",
  "task_view_state",
]);

// Requests are intentionally case-sensitive and lowercase-only, so env vars like $PATH don't
// produce noisy "missing capability" expansions.
const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const DEFAULT_MAX_REQUESTED_DETAILS = 4;
const DEFAULT_MAX_VISIBLE_NAMES = 12;
const SURFACE_ORDER: Record<CapabilitySurface, number> = {
  base: 0,
  skill: 1,
  operator: 2,
  external: 3,
};
const POSTURE_ORDER: Record<ToolInvocationPosture, number> = {
  observe: 0,
  reversible_mutate: 1,
  commitment: 2,
};

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function compactText(value: string, maxChars = 200): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function extractParameterKeys(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const schema = parameters as {
    type?: unknown;
    properties?: unknown;
  };
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    return [];
  }
  return Object.keys(schema.properties as Record<string, unknown>).toSorted();
}

function resolveCapabilitySurface(name: string): CapabilitySurface {
  return getBrewvaToolSurface(name) ?? "external";
}

function resolveCapabilityPosture(name: string): {
  posture: ToolInvocationPosture;
  effects: ToolEffectClass[];
} {
  const descriptor = getToolGovernanceDescriptor(name);
  return {
    posture: descriptor?.posture ?? "observe",
    effects: [...(descriptor?.effects ?? [])],
  };
}

function createEmptyInventory(): CapabilityVisibilityInventory {
  return {
    availableTotal: 0,
    visibleNames: [],
    visibleByPosture: {
      observe: 0,
      reversible_mutate: 0,
      commitment: 0,
    },
    hiddenBySurface: {
      base: 0,
      skill: 0,
      operator: 0,
      external: 0,
    },
    hints: [],
  };
}

function toCapabilityEntries(input: BuildCapabilityViewInput): CapabilityEntry[] {
  const activeToolNames = new Set(
    input.activeToolNames.map((name) => normalizeToolName(name)).filter((name) => name.length > 0),
  );
  const entries: CapabilityEntry[] = [];
  for (const tool of input.allTools) {
    const name = normalizeToolName(tool.name);
    if (!name) continue;
    entries.push({
      name,
      description: tool.description.trim(),
      parameterKeys: extractParameterKeys(tool.parameters),
      visible: activeToolNames.has(name),
      governance: GOVERNANCE_TOOL_NAMES.has(name),
      surface: resolveCapabilitySurface(name),
      ...resolveCapabilityPosture(name),
    });
  }
  entries.sort((left, right) => {
    if (left.visible !== right.visible) {
      return left.visible ? -1 : 1;
    }
    if (left.surface !== right.surface) {
      return SURFACE_ORDER[left.surface] - SURFACE_ORDER[right.surface];
    }
    if (left.governance !== right.governance) {
      return left.governance ? -1 : 1;
    }
    if (left.posture !== right.posture) {
      return POSTURE_ORDER[left.posture] - POSTURE_ORDER[right.posture];
    }
    return left.name.localeCompare(right.name);
  });
  return entries;
}

function extractRequestedCapabilities(prompt: string): string[] {
  const requested = new Set<string>();
  for (const match of prompt.matchAll(CAPABILITY_REQUEST_PATTERN)) {
    const raw = match[1];
    const name = typeof raw === "string" ? normalizeToolName(raw) : "";
    if (name) requested.add(name);
  }
  return [...requested.values()];
}

function formatVisibleNames(names: string[], maxCount: number): string {
  const capped = names.slice(0, maxCount).map((name) => `$${name}`);
  const remaining = names.length - capped.length;
  if (remaining > 0) {
    capped.push(`+${remaining} more`);
  }
  return capped.join(", ");
}

function formatFullDetailBlock(detail: CapabilityDetail): string {
  const parameters = detail.parameterKeys.length > 0 ? detail.parameterKeys.join(", ") : "(none)";
  const description = detail.description || "(no description)";
  const lines = [
    `[CapabilityDetail:$${detail.name}]`,
    `description: ${description}`,
    `parameters: ${parameters}`,
    `surface: ${detail.surface}`,
    `posture: ${detail.posture}`,
    `effects: ${detail.effects.length > 0 ? detail.effects.join(", ") : "(none)"}`,
    `visible_now: ${detail.visibleNow ? "true" : "false"}`,
    `governance: ${detail.governance ? "true" : "false"}`,
  ];

  if (detail.access) {
    lines.push(`allowed_now: ${detail.access.allowed ? "true" : "false"}`);
    if (detail.access.warning) {
      lines.push(`warning: ${compactText(detail.access.warning, 260)}`);
    }
    if (!detail.access.allowed) {
      lines.push(`deny_reason: ${compactText(detail.access.reason ?? "Tool call blocked.", 360)}`);
    }
  }

  return lines.join("\n");
}

function formatCompactDetailBlock(detail: CapabilityDetail): string {
  const parameters = detail.parameterKeys.length > 0 ? detail.parameterKeys.join(", ") : "(none)";
  const lines = [
    `[CapabilityDetail:$${detail.name}]`,
    `parameters: ${parameters}`,
    `posture: ${detail.posture}`,
    `effects: ${detail.effects.length > 0 ? detail.effects.join(", ") : "(none)"}`,
  ];

  if (detail.access) {
    lines.push(`allowed_now: ${detail.access.allowed ? "true" : "false"}`);
    if (detail.access.warning) {
      lines.push(`warning: ${compactText(detail.access.warning, 180)}`);
    }
    if (!detail.access.allowed) {
      lines.push(`deny_reason: ${compactText(detail.access.reason ?? "Tool call blocked.", 220)}`);
    }
  }

  return lines.join("\n");
}

function renderSummaryBlock(
  inventory: CapabilityVisibilityInventory,
  maxVisibleNames: number,
): Pick<CapabilityRenderedBlock, "content" | "compactContent"> {
  const visibleNow = formatVisibleNames(inventory.visibleNames, maxVisibleNames);
  return {
    content: [
      "[CapabilityView]",
      `available_total: ${inventory.availableTotal}`,
      `visible_now_count: ${inventory.visibleNames.length}`,
      `visible_now: ${visibleNow}`,
      `visible_postures: observe=${inventory.visibleByPosture.observe} reversible_mutate=${inventory.visibleByPosture.reversible_mutate} commitment=${inventory.visibleByPosture.commitment}`,
    ].join("\n"),
    compactContent: [
      "[CapabilityView]",
      `visible_now: ${visibleNow}`,
      `visible_postures: observe=${inventory.visibleByPosture.observe} reversible_mutate=${inventory.visibleByPosture.reversible_mutate} commitment=${inventory.visibleByPosture.commitment}`,
    ].join("\n"),
  };
}

function renderInventoryBlock(inventory: CapabilityVisibilityInventory): string {
  const lines = [
    `hidden_skill_count: ${inventory.hiddenBySurface.skill}`,
    `hidden_operator_count: ${inventory.hiddenBySurface.operator}`,
    `hidden_external_count: ${inventory.hiddenBySurface.external}`,
  ];
  if (inventory.hints.includes("load_or_accept_skill")) {
    lines.push("skill_hint: load or accept a skill to expose task-specific tools.");
  }
  if (inventory.hints.includes("operator_profile_available")) {
    lines.push(
      "operator_hint: operator/full profile keeps these tools visible; otherwise request one via `$name` for the current turn.",
    );
  }
  return lines.join("\n");
}

function renderPolicyBlock(
  policies: CapabilityViewPolicy[],
): Pick<CapabilityRenderedBlock, "content" | "compactContent"> {
  const lines: string[] = [];
  const compactLines: string[] = [];

  for (const policy of policies) {
    if (policy.id === "surface_visibility") {
      lines.push(
        "surface_policy: base tools stay visible; skill tools follow current skill commitments; any managed tool can be surfaced for one turn with an explicit $name request; operator/full profile keeps operator tools visible by default.",
      );
      continue;
    }
    if (policy.id === "posture_boundaries") {
      const text =
        "posture_policy: observe tools favor exploration, reversible_mutate tools create local rollback or journal anchors, commitment tools require explicit effect authorization.";
      lines.push(text);
      compactLines.push(text);
      continue;
    }
    if (policy.id === "explicit_request_expansion") {
      const text = "expand_hint: include `$name` in your turn to reveal one capability detail.";
      lines.push(text);
      compactLines.push(text);
    }
  }

  return {
    content: lines.join("\n"),
    compactContent: compactLines.join("\n"),
  };
}

function chooseRenderedBlockContent(input: {
  mode: CapabilityRenderMode;
  full: string;
  compact?: string;
}): Pick<CapabilityRenderedBlock, "content" | "compactContent"> {
  if (input.mode === "compact" && input.compact) {
    return {
      content: input.compact,
    };
  }
  return {
    content: input.full,
    compactContent:
      input.compact && input.compact.trim().length > 0 && input.compact !== input.full
        ? input.compact
        : undefined,
  };
}

export function buildCapabilityView(input: BuildCapabilityViewInput): BuildCapabilityViewResult {
  const entries = toCapabilityEntries(input);
  if (entries.length === 0) {
    return {
      inventory: createEmptyInventory(),
      policies: [],
      requested: [],
      details: [],
      missing: [],
    };
  }

  const visibleEntries = entries.filter((entry) => entry.visible);
  const requested = extractRequestedCapabilities(input.prompt);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const maxRequestedDetails = Math.max(
    1,
    Math.floor(input.maxRequestedDetails ?? DEFAULT_MAX_REQUESTED_DETAILS),
  );
  const details: CapabilityDetail[] = [];
  const missing: string[] = [];

  for (const name of requested.slice(0, maxRequestedDetails)) {
    const entry = byName.get(name);
    if (!entry) {
      missing.push(name);
      continue;
    }
    details.push({
      name: entry.name,
      description: entry.description,
      parameterKeys: entry.parameterKeys,
      surface: entry.surface,
      posture: entry.posture,
      effects: entry.effects,
      visibleNow: entry.visible,
      governance: entry.governance,
      access: input.resolveAccess?.(entry.name),
    });
  }

  const inventory: CapabilityVisibilityInventory = {
    availableTotal: entries.length,
    visibleNames: visibleEntries.map((entry) => entry.name),
    visibleByPosture: {
      observe: visibleEntries.filter((entry) => entry.posture === "observe").length,
      reversible_mutate: visibleEntries.filter((entry) => entry.posture === "reversible_mutate")
        .length,
      commitment: visibleEntries.filter((entry) => entry.posture === "commitment").length,
    },
    hiddenBySurface: {
      base: entries.filter((entry) => !entry.visible && entry.surface === "base").length,
      skill: entries.filter((entry) => !entry.visible && entry.surface === "skill").length,
      operator: entries.filter((entry) => !entry.visible && entry.surface === "operator").length,
      external: entries.filter((entry) => !entry.visible && entry.surface === "external").length,
    },
    hints: [],
  };

  const visibleSkillCount = visibleEntries.filter((entry) => entry.surface === "skill").length;
  if (inventory.hiddenBySurface.skill > 0 && visibleSkillCount === 0) {
    inventory.hints.push("load_or_accept_skill");
  }
  if (inventory.hiddenBySurface.operator > 0) {
    inventory.hints.push("operator_profile_available");
  }

  return {
    inventory,
    policies: [
      { id: "surface_visibility" },
      { id: "posture_boundaries" },
      { id: "explicit_request_expansion" },
    ],
    requested,
    details,
    missing,
  };
}

export function renderCapabilityView(input: RenderCapabilityViewInput): CapabilityRenderedBlock[] {
  const mode = input.mode ?? "full";
  const includeInventory = input.includeInventory ?? true;
  const maxVisibleNames = Math.max(
    1,
    Math.floor(input.maxVisibleNames ?? DEFAULT_MAX_VISIBLE_NAMES),
  );
  const { capabilityView } = input;

  if (capabilityView.inventory.availableTotal === 0) {
    return [];
  }

  const summary = renderSummaryBlock(capabilityView.inventory, maxVisibleNames);
  const policy = renderPolicyBlock(capabilityView.policies);
  const blocks: CapabilityRenderedBlock[] = [
    {
      id: "capability-view-summary",
      kind: "summary",
      priority: "essential",
      ...chooseRenderedBlockContent({
        mode,
        full: summary.content,
        compact: summary.compactContent,
      }),
    },
    {
      id: "capability-view-policy",
      kind: "policy",
      priority: "essential",
      ...chooseRenderedBlockContent({
        mode,
        full: policy.content,
        compact: policy.compactContent,
      }),
    },
  ];

  if (includeInventory) {
    blocks.push({
      id: "capability-view-inventory",
      kind: "inventory",
      priority: "optional",
      content: renderInventoryBlock(capabilityView.inventory),
    });
  }

  for (const detail of capabilityView.details) {
    blocks.push({
      id: `capability-detail:${detail.name}`,
      kind: "detail",
      priority: "requested",
      ...chooseRenderedBlockContent({
        mode,
        full: formatFullDetailBlock(detail),
        compact: formatCompactDetailBlock(detail),
      }),
    });
  }

  if (capabilityView.missing.length > 0) {
    blocks.push({
      id: "capability-detail-missing",
      kind: "missing",
      priority: "requested",
      content: [
        "[CapabilityDetailMissing]",
        `unknown: ${capabilityView.missing.map((name) => `$${name}`).join(", ")}`,
      ].join("\n"),
    });
  }

  return blocks;
}
