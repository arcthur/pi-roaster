import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONTROL_PLANE_TOOLS } from "../security/control-plane-tools.js";
import type { SkillContract, SkillContractOverride, SkillDocument, SkillTier } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";

interface ParsedFrontmatter {
  body: string;
  data: Record<string, unknown>;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    return { body: markdown, data: {} };
  }

  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = parseYaml(yamlText);
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

  return { body, data };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function normalizeStringList(value: unknown): string[] {
  return toStringArray(value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toToolNameArray(value: unknown): string[] {
  return normalizeStringList(value)
    .map((tool) => normalizeToolName(tool))
    .filter((tool) => tool.length > 0);
}

function toString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeDispatchPolicy(
  data: Record<string, unknown>,
): SkillContract["dispatch"] | undefined {
  const rawDispatch =
    typeof data.dispatch === "object" && data.dispatch && !Array.isArray(data.dispatch)
      ? (data.dispatch as Record<string, unknown>)
      : {};
  const gateThreshold = normalizePositiveInteger(
    rawDispatch.gate_threshold ?? rawDispatch.gateThreshold,
    10,
  );
  const autoThreshold = Math.max(
    gateThreshold,
    normalizePositiveInteger(rawDispatch.auto_threshold ?? rawDispatch.autoThreshold, 16),
  );
  const modeCandidate = rawDispatch.default_mode ?? rawDispatch.defaultMode;
  const defaultMode =
    modeCandidate === "gate" || modeCandidate === "auto" || modeCandidate === "suggest"
      ? modeCandidate
      : "suggest";
  return {
    gateThreshold,
    autoThreshold,
    defaultMode,
  };
}

function normalizeContract(
  name: string,
  tier: SkillTier,
  data: Record<string, unknown>,
): SkillContract {
  const tools = (typeof data.tools === "object" && data.tools ? data.tools : {}) as Record<
    string,
    unknown
  >;
  const budget = (typeof data.budget === "object" && data.budget ? data.budget : {}) as Record<
    string,
    unknown
  >;

  const required = toToolNameArray(tools.required);
  const optional = toToolNameArray(tools.optional);
  const controlPlaneToolSet = new Set(
    CONTROL_PLANE_TOOLS.map((tool) => normalizeToolName(tool)).filter((tool) => tool.length > 0),
  );
  const denied = toToolNameArray(tools.denied).filter((tool) => !controlPlaneToolSet.has(tool));

  const maxToolCalls =
    typeof budget.max_tool_calls === "number"
      ? budget.max_tool_calls
      : typeof budget.maxToolCalls === "number"
        ? budget.maxToolCalls
        : 50;

  const maxTokens =
    typeof budget.max_tokens === "number"
      ? budget.max_tokens
      : typeof budget.maxTokens === "number"
        ? budget.maxTokens
        : 100_000;

  const antiTags = normalizeStringList(data.anti_tags ?? data.antiTags);
  const outputs = normalizeStringList(data.outputs);
  const composableWith = normalizeStringList(data.composable_with ?? data.composableWith);
  const consumes = normalizeStringList(data.consumes);
  const dispatch = normalizeDispatchPolicy(data);
  const escalationPath =
    typeof data.escalation_path === "object" &&
    data.escalation_path &&
    !Array.isArray(data.escalation_path)
      ? (data.escalation_path as Record<string, string>)
      : typeof data.escalationPath === "object" &&
          data.escalationPath &&
          !Array.isArray(data.escalationPath)
        ? (data.escalationPath as Record<string, string>)
        : undefined;

  return {
    name,
    tier,
    description: typeof data.description === "string" ? data.description : undefined,
    tags: normalizeStringList(data.tags),
    antiTags,
    dispatch,
    tools: {
      required,
      optional,
      denied,
    },
    budget: {
      maxToolCalls: Math.max(1, Math.trunc(maxToolCalls)),
      maxTokens: Math.max(1000, Math.trunc(maxTokens)),
    },
    outputs,
    composableWith,
    consumes,
    escalationPath,
    maxParallel:
      typeof data.max_parallel === "number"
        ? Math.max(1, Math.trunc(data.max_parallel))
        : undefined,
    stability:
      data.stability === "experimental" || data.stability === "deprecated"
        ? data.stability
        : "stable",
    version: typeof data.version === "string" ? data.version : undefined,
    costHint: data.cost_hint === "high" || data.cost_hint === "low" ? data.cost_hint : "medium",
  };
}

export function tightenContract(
  base: SkillContract,
  override: SkillContractOverride,
): SkillContract {
  const baseDenied = new Set([...base.tools.denied].map((tool) => normalizeToolName(tool)));
  const baseAllowed = new Set(
    [...base.tools.required, ...base.tools.optional]
      .map((tool) => normalizeToolName(tool))
      .filter((tool) => tool.length > 0)
      .filter((tool) => !baseDenied.has(tool)),
  );

  const denied = new Set(baseDenied);
  for (const tool of override.tools?.denied ?? []) {
    const normalized = normalizeToolName(tool);
    if (normalized) denied.add(normalized);
  }

  const required = new Set(
    [...base.tools.required].map((tool) => normalizeToolName(tool)).filter(Boolean),
  );
  for (const tool of override.tools?.required ?? []) {
    const normalized = normalizeToolName(tool);
    if (!normalized) continue;
    if (baseAllowed.has(normalized)) {
      required.add(normalized);
    }
  }

  const optionalSource = override.tools?.optional ?? base.tools.optional;
  const optional = new Set<string>();
  for (const tool of optionalSource) {
    const normalized = normalizeToolName(tool);
    if (!normalized) continue;
    if (!baseAllowed.has(normalized)) continue;
    if (denied.has(normalized)) continue;
    if (required.has(normalized)) continue;
    optional.add(normalized);
  }

  const maxToolCalls =
    typeof override.budget?.maxToolCalls === "number"
      ? Math.min(base.budget.maxToolCalls, override.budget.maxToolCalls)
      : base.budget.maxToolCalls;
  const maxTokens =
    typeof override.budget?.maxTokens === "number"
      ? Math.min(base.budget.maxTokens, override.budget.maxTokens)
      : base.budget.maxTokens;
  const maxParallel =
    typeof override.maxParallel === "number"
      ? Math.min(base.maxParallel ?? override.maxParallel, override.maxParallel)
      : base.maxParallel;

  const dispatch = (() => {
    const baseDispatch = base.dispatch ?? {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest" as const,
    };
    const overrideDispatch = override.dispatch;
    if (!overrideDispatch) return base.dispatch;
    const gateThreshold =
      typeof overrideDispatch.gateThreshold === "number"
        ? Math.max(baseDispatch.gateThreshold, Math.floor(overrideDispatch.gateThreshold))
        : baseDispatch.gateThreshold;
    const autoThreshold =
      typeof overrideDispatch.autoThreshold === "number"
        ? Math.max(baseDispatch.autoThreshold, Math.floor(overrideDispatch.autoThreshold))
        : baseDispatch.autoThreshold;
    const defaultMode =
      overrideDispatch.defaultMode === "auto" ||
      overrideDispatch.defaultMode === "gate" ||
      overrideDispatch.defaultMode === "suggest"
        ? overrideDispatch.defaultMode
        : baseDispatch.defaultMode;
    return {
      gateThreshold,
      autoThreshold: Math.max(gateThreshold, autoThreshold),
      defaultMode,
    };
  })();

  return {
    ...base,
    tags: override.tags ?? base.tags,
    antiTags: override.antiTags ?? base.antiTags,
    dispatch,
    outputs: override.outputs ?? base.outputs,
    composableWith: override.composableWith ?? base.composableWith,
    consumes: override.consumes ?? base.consumes,
    escalationPath: override.escalationPath ?? base.escalationPath,
    maxParallel,
    tools: {
      required: [...required],
      optional: [...optional],
      denied: [...denied],
    },
    budget: {
      maxToolCalls,
      maxTokens,
    },
  };
}

export function parseSkillDocument(filePath: string, tier: SkillTier): SkillDocument {
  const raw = readFileSync(filePath, "utf8");
  const { body, data } = parseFrontmatter(raw);

  const inferredName = toString(data.name, basename(dirname(filePath)) ?? "skill");
  const description = toString(data.description, `${inferredName} skill`);
  const contract = normalizeContract(inferredName, tier, data);

  return {
    name: inferredName,
    description,
    tier,
    filePath,
    baseDir: dirname(filePath),
    markdown: body.trim(),
    contract,
  };
}
