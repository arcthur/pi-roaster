import type { BrewvaRuntime, SkillDocument } from "@brewva/brewva-runtime";
import {
  BASE_BREWVA_TOOL_NAMES,
  getBrewvaToolSurface,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  isManagedBrewvaToolName,
} from "@brewva/brewva-tools";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@mariozechner/pi-coding-agent";

const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const BUILTIN_ALWAYS_ON_TOOL_NAMES = ["read", "edit", "write"] as const;
const TOOL_SURFACE_RESOLVED_EVENT_TYPE = "tool_surface_resolved";
const MANAGED_TOOL_NAME_SET = new Set(MANAGED_BREWVA_TOOL_NAMES);

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function extractRequestedToolNames(prompt: string): string[] {
  const requested = new Set<string>();
  for (const match of prompt.matchAll(CAPABILITY_REQUEST_PATTERN)) {
    const raw = match[1];
    if (typeof raw !== "string") continue;
    const normalized = normalizeToolName(raw);
    if (normalized.length > 0) {
      requested.add(normalized);
    }
  }
  return [...requested];
}

function isOperatorProfile(runtime: BrewvaRuntime): boolean {
  const profile = runtime.config.skills.routing.profile;
  if (profile === "operator" || profile === "full") {
    return true;
  }
  const scopes = new Set(runtime.config.skills.routing.scopes);
  return scopes.has("operator") || scopes.has("meta");
}

function appendSkillName(names: string[], skillName: string | null | undefined): void {
  if (typeof skillName !== "string") return;
  const trimmed = skillName.trim();
  if (!trimmed || names.includes(trimmed)) return;
  names.push(trimmed);
}

function resolveSurfaceSkills(runtime: BrewvaRuntime, sessionId: string): SkillDocument[] {
  const names: string[] = [];
  const active = runtime.skills.getActive(sessionId);
  const pendingDispatch = runtime.skills.getPendingDispatch(sessionId);
  const cascadeIntent = runtime.skills.getCascadeIntent(sessionId);

  appendSkillName(names, active?.name);
  appendSkillName(names, pendingDispatch?.primary?.name);
  appendSkillName(names, pendingDispatch?.chain[0]);
  appendSkillName(names, cascadeIntent?.steps[cascadeIntent.cursor]?.skill);

  return names
    .map((name) => runtime.skills.get(name))
    .filter((skill): skill is SkillDocument => skill !== undefined);
}

function collectSkillToolNames(skills: SkillDocument[]): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    for (const toolName of skill.contract.tools.required) {
      names.add(normalizeToolName(toolName));
    }
    for (const toolName of skill.contract.tools.optional) {
      names.add(normalizeToolName(toolName));
    }
  }
  return [...names];
}

function resolveRequestedManagedToolNames(
  requestedToolNames: string[],
  knownToolNames: Set<string>,
): string[] {
  return requestedToolNames.filter((toolName) => {
    if (!knownToolNames.has(toolName)) return false;
    return isManagedBrewvaToolName(toolName);
  });
}

function resolveManagedToolNamesForTurn(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  prompt: string;
}): {
  requestedManagedToolNames: string[];
  skillManagedToolNames: string[];
  lifecycleManagedToolNames: string[];
  operatorManagedToolNames: string[];
} {
  const requestedManagedToolNames = extractRequestedToolNames(input.prompt).filter((toolName) =>
    MANAGED_TOOL_NAME_SET.has(toolName),
  );
  const surfaceSkills = resolveSurfaceSkills(input.runtime, input.sessionId);
  const skillManagedToolNames = collectSkillToolNames(surfaceSkills).filter((toolName) =>
    MANAGED_TOOL_NAME_SET.has(toolName),
  );
  const lifecycleManagedToolNames: string[] = [];

  if (surfaceSkills.length > 0) {
    lifecycleManagedToolNames.push("skill_complete");
  }
  if (input.runtime.skills.getPendingDispatch(input.sessionId)) {
    lifecycleManagedToolNames.push("skill_load", "skill_route_override");
  }
  if (input.runtime.skills.getCascadeIntent(input.sessionId)) {
    lifecycleManagedToolNames.push("skill_chain_control");
  }

  const operatorManagedToolNames = isOperatorProfile(input.runtime)
    ? OPERATOR_BREWVA_TOOL_NAMES
    : [];

  return {
    requestedManagedToolNames,
    skillManagedToolNames,
    lifecycleManagedToolNames: [...new Set(lifecycleManagedToolNames)],
    operatorManagedToolNames,
  };
}

function resolveActiveToolNames(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  prompt: string;
  allTools: ToolInfo[];
  activeToolNames: string[];
}): {
  activeToolNames: string[];
  managedActiveCount: number;
  requestedToolNames: string[];
  requestedActivatedToolNames: string[];
  ignoredRequestedToolNames: string[];
  skillNames: string[];
  operatorProfile: boolean;
  baseActiveCount: number;
  skillActiveCount: number;
  operatorActiveCount: number;
  externalActiveCount: number;
  hiddenSkillCount: number;
  hiddenOperatorCount: number;
} {
  const allToolNames = input.allTools.map((tool) => normalizeToolName(tool.name));
  const knownToolNames = new Set(allToolNames);
  const active = new Set<string>();

  for (const toolName of input.activeToolNames) {
    const normalized = normalizeToolName(toolName);
    if (!knownToolNames.has(normalized)) continue;
    if (!isManagedBrewvaToolName(normalized)) {
      active.add(normalized);
    }
  }

  for (const toolName of BUILTIN_ALWAYS_ON_TOOL_NAMES) {
    if (knownToolNames.has(toolName)) {
      active.add(toolName);
    }
  }
  for (const toolName of BASE_BREWVA_TOOL_NAMES) {
    if (knownToolNames.has(toolName)) {
      active.add(toolName);
    }
  }

  const requestedToolNames = extractRequestedToolNames(input.prompt).filter((toolName) =>
    knownToolNames.has(toolName),
  );
  const requestedActivatedToolNames = resolveRequestedManagedToolNames(
    requestedToolNames,
    knownToolNames,
  );
  for (const toolName of requestedActivatedToolNames) {
    active.add(toolName);
  }

  const surfaceSkills = resolveSurfaceSkills(input.runtime, input.sessionId);
  for (const toolName of collectSkillToolNames(surfaceSkills)) {
    if (knownToolNames.has(toolName)) {
      active.add(toolName);
    }
  }

  if (surfaceSkills.length > 0 && knownToolNames.has("skill_complete")) {
    active.add("skill_complete");
  }
  if (
    input.runtime.skills.getPendingDispatch(input.sessionId) &&
    knownToolNames.has("skill_load")
  ) {
    active.add("skill_load");
  }
  if (
    input.runtime.skills.getPendingDispatch(input.sessionId) &&
    knownToolNames.has("skill_route_override")
  ) {
    active.add("skill_route_override");
  }
  if (
    input.runtime.skills.getCascadeIntent(input.sessionId) &&
    knownToolNames.has("skill_chain_control")
  ) {
    active.add("skill_chain_control");
  }

  const operatorProfile = isOperatorProfile(input.runtime);
  if (operatorProfile) {
    for (const toolName of OPERATOR_BREWVA_TOOL_NAMES) {
      if (knownToolNames.has(toolName)) {
        active.add(toolName);
      }
    }
  }

  const activeToolNames = allToolNames.filter((toolName) => active.has(toolName));
  const baseActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === "base",
  ).length;
  const skillActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === "skill",
  ).length;
  const operatorActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === "operator",
  ).length;
  const externalActiveCount = activeToolNames.filter(
    (toolName) => getBrewvaToolSurface(toolName) === undefined,
  ).length;
  const hiddenSkillCount = allToolNames.filter(
    (toolName) => !active.has(toolName) && getBrewvaToolSurface(toolName) === "skill",
  ).length;
  const hiddenOperatorCount = allToolNames.filter(
    (toolName) => !active.has(toolName) && getBrewvaToolSurface(toolName) === "operator",
  ).length;

  return {
    activeToolNames,
    managedActiveCount: [...active].filter((toolName) => isManagedBrewvaToolName(toolName)).length,
    requestedToolNames,
    requestedActivatedToolNames,
    ignoredRequestedToolNames: requestedToolNames.filter(
      (toolName) => !requestedActivatedToolNames.includes(toolName),
    ),
    skillNames: surfaceSkills.map((skill) => skill.name),
    operatorProfile,
    baseActiveCount,
    skillActiveCount,
    operatorActiveCount,
    externalActiveCount,
    hiddenSkillCount,
    hiddenOperatorCount,
  };
}

export interface RegisterToolSurfaceOptions {
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
}

function registerMissingManagedTools(input: {
  pi: ExtensionAPI;
  runtime: BrewvaRuntime;
  sessionId: string;
  prompt: string;
  dynamicToolDefinitions?: ReadonlyMap<string, ToolDefinition>;
  knownToolNames: Set<string>;
}): void {
  if (!input.dynamicToolDefinitions || input.dynamicToolDefinitions.size === 0) return;

  const dynamic = resolveManagedToolNamesForTurn({
    runtime: input.runtime,
    sessionId: input.sessionId,
    prompt: input.prompt,
  });
  const namesToEnsure = [
    ...dynamic.requestedManagedToolNames,
    ...dynamic.skillManagedToolNames,
    ...dynamic.lifecycleManagedToolNames,
    ...dynamic.operatorManagedToolNames,
  ];

  for (const toolName of new Set(namesToEnsure)) {
    if (input.knownToolNames.has(toolName)) continue;
    const toolDefinition = input.dynamicToolDefinitions.get(toolName);
    if (!toolDefinition) continue;
    input.pi.registerTool(toolDefinition);
    input.knownToolNames.add(toolName);
  }
}

export function registerToolSurface(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: RegisterToolSurfaceOptions = {},
): void {
  pi.on("before_agent_start", (event, ctx) => {
    const allToolsGetter = (pi as { getAllTools?: () => ToolInfo[] }).getAllTools;
    const activeToolsGetter = (pi as { getActiveTools?: () => string[] }).getActiveTools;
    const setActiveTools = (pi as { setActiveTools?: (toolNames: string[]) => void })
      .setActiveTools;
    if (
      typeof allToolsGetter !== "function" ||
      typeof activeToolsGetter !== "function" ||
      typeof setActiveTools !== "function"
    ) {
      return undefined;
    }

    const allTools = allToolsGetter.call(pi);
    if (!Array.isArray(allTools) || allTools.length === 0) {
      return undefined;
    }

    const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? event.prompt : "";
    const sessionId = ctx.sessionManager.getSessionId();
    const knownToolNames = new Set(allTools.map((tool) => normalizeToolName(tool.name)));
    registerMissingManagedTools({
      pi,
      runtime,
      sessionId,
      prompt,
      dynamicToolDefinitions: options.dynamicToolDefinitions,
      knownToolNames,
    });
    const refreshedTools = allToolsGetter.call(pi);
    if (!Array.isArray(refreshedTools) || refreshedTools.length === 0) {
      return undefined;
    }
    const resolved = resolveActiveToolNames({
      runtime,
      sessionId,
      prompt,
      allTools: refreshedTools,
      activeToolNames: activeToolsGetter.call(pi),
    });
    setActiveTools.call(pi, resolved.activeToolNames);

    runtime.events.record({
      sessionId,
      type: TOOL_SURFACE_RESOLVED_EVENT_TYPE,
      payload: {
        availableCount: refreshedTools.length,
        activeCount: resolved.activeToolNames.length,
        managedCount: MANAGED_BREWVA_TOOL_NAMES.length,
        managedActiveCount: resolved.managedActiveCount,
        requestedToolNames: resolved.requestedToolNames,
        requestedActivatedToolNames: resolved.requestedActivatedToolNames,
        ignoredRequestedToolNames: resolved.ignoredRequestedToolNames,
        skillNames: resolved.skillNames,
        operatorProfile: resolved.operatorProfile,
        baseActiveCount: resolved.baseActiveCount,
        skillActiveCount: resolved.skillActiveCount,
        operatorActiveCount: resolved.operatorActiveCount,
        externalActiveCount: resolved.externalActiveCount,
        hiddenSkillCount: resolved.hiddenSkillCount,
        hiddenOperatorCount: resolved.hiddenOperatorCount,
      },
    });
    return undefined;
  });
}
