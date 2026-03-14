import { join, resolve } from "node:path";
import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  recordAssistantUsageFromMessage,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions,
} from "@brewva/brewva-runtime";
import { createSkillBrokerExtension } from "@brewva/brewva-skill-broker";
import { buildBrewvaTools, resolveBrewvaModelSelection } from "@brewva/brewva-tools";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  editTool,
  ModelRegistry,
  readTool,
  SettingsManager,
  writeTool,
  type AgentSessionEvent,
  type CreateAgentSessionResult,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { AddonHost } from "../addons/host.js";
import {
  createBrewvaExtension,
  createRuntimeCoreBridgeExtension,
} from "../runtime-plugins/index.js";

export interface HostedSessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
  addonHost?: AddonHost;
}

export interface CreateHostedSessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime;
  addonHost?: AddonHost;
  extensionFactories?: ExtensionFactory[];
  scopeId?: string;
}

function applyRuntimeUiSettings(
  settingsManager: SettingsManager,
  uiConfig: BrewvaRuntime["config"]["ui"],
): void {
  settingsManager.applyOverrides({
    quietStartup: uiConfig.quietStartup,
  });
}

export function registerRuntimeCoreEventBridge(
  runtime: BrewvaRuntime,
  session: HostedSessionResult["session"],
): () => void {
  let turnIndex = 0;

  return session.subscribe((event: AgentSessionEvent) => {
    const sessionId = session.sessionManager.getSessionId();

    switch (event.type) {
      case "agent_start":
        turnIndex = 0;
        runtime.events.record({
          sessionId,
          type: "agent_start",
        });
        break;
      case "turn_start":
        runtime.context.onTurnStart(sessionId, turnIndex);
        runtime.events.record({
          sessionId,
          type: "turn_start",
          turn: turnIndex,
        });
        break;
      case "turn_end": {
        const toolResults = Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;
        runtime.context.onTurnEnd(sessionId);
        runtime.skills.reconcilePendingDispatch(sessionId, turnIndex);
        runtime.events.record({
          sessionId,
          type: "turn_end",
          turn: turnIndex,
          payload: { toolResults },
        });
        turnIndex += 1;
        break;
      }
      case "message_end":
        recordAssistantUsageFromMessage(
          runtime,
          sessionId,
          (event as { message?: unknown }).message,
        );
        break;
      case "tool_execution_start":
        runtime.events.record({
          sessionId,
          type: "tool_execution_start",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
          },
        });
        break;
      case "tool_execution_update":
        runtime.events.record({
          sessionId,
          type: "tool_execution_update",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
          },
        });
        break;
      case "tool_execution_end":
        runtime.events.record({
          sessionId,
          type: "tool_execution_end",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
            isError: (event as { isError?: unknown }).isError === true,
          },
        });
        break;
      case "agent_end":
        runtime.events.record({
          sessionId,
          type: "agent_end",
          payload: {
            messageCount: Array.isArray((event as { messages?: unknown }).messages)
              ? (event as { messages: unknown[] }).messages.length
              : 0,
            costSummary: runtime.cost.getSummary(sessionId),
          },
        });
        break;
      default:
        break;
    }
  });
}

export async function createHostedSession(
  options: CreateHostedSessionOptions = {},
): Promise<HostedSessionResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();
  const resolvedAddonHost =
    options.addonHost ??
    (() => {
      const host = new AddonHost({ cwd });
      return host;
    })();

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveBrewvaModelSelection(options.model, modelRegistry);

  const runtime =
    options.runtime ??
    new BrewvaRuntime({
      cwd,
      configPath: options.configPath,
      config: undefined,
      agentId: options.agentId,
      governancePort: createTrustedLocalGovernancePort(),
    });

  const hasRoutingOverride = Boolean(options.routingScopes && options.routingScopes.length > 0);
  if (options.routingScopes && options.routingScopes.length > 0) {
    runtime.config.skills.routing.enabled = true;
    runtime.config.skills.routing.scopes = [...new Set(options.routingScopes)];
  }
  if (hasRoutingOverride) {
    runtime.skills.refresh();
  }
  const skillLoadReport = runtime.skills.getLoadReport();

  const settingsManager = SettingsManager.create(cwd, agentDir);
  applyRuntimeUiSettings(settingsManager, runtime.config.ui);

  const extensionsEnabled = options.enableExtensions !== false;
  const skillBrokerEnabled = runtime.config.skills.routing.enabled || hasRoutingOverride;
  const extensionFactories = [
    ...(skillBrokerEnabled ? [createSkillBrokerExtension({ runtime })] : []),
    ...(extensionsEnabled
      ? [createBrewvaExtension({ runtime, registerTools: true })]
      : [createRuntimeCoreBridgeExtension({ runtime })]),
  ];
  if (options.extensionFactories && options.extensionFactories.length > 0) {
    extensionFactories.push(...options.extensionFactories);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();

  const customTools = extensionsEnabled ? undefined : buildBrewvaTools({ runtime });

  const sessionResult = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    model: selectedModel.model,
    thinkingLevel: selectedModel.thinkingLevel,
    tools: [readTool, editTool, writeTool],
    customTools,
  });

  const sessionId = sessionResult.session.sessionManager.getSessionId();
  if (!extensionsEnabled) {
    runtime.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd },
    });
    registerRuntimeCoreEventBridge(runtime, sessionResult.session);
  }

  await resolvedAddonHost.loadAll();
  const loadedAddons = resolvedAddonHost.listAddons();
  if (loadedAddons.length > 0) {
    await resolvedAddonHost.applyContextPackets(runtime, sessionId, options.scopeId);
  }

  runtime.events.record({
    sessionId,
    type: "session_bootstrap",
    payload: {
      cwd,
      agentId: runtime.agentId,
      extensionsEnabled,
      addonsEnabled: loadedAddons.length > 0,
      skillBroker: {
        enabled: skillBrokerEnabled,
        proposalBoundary: skillBrokerEnabled ? "runtime.proposals.submit" : null,
      },
      skillLoad: {
        routingEnabled: skillLoadReport.routingEnabled,
        routingScopes: skillLoadReport.routingScopes,
        routableSkills: skillLoadReport.routableSkills,
        hiddenSkills: skillLoadReport.hiddenSkills,
        overlaySkills: skillLoadReport.overlaySkills,
      },
    },
  });

  return {
    ...sessionResult,
    runtime,
    addonHost: loadedAddons.length > 0 ? resolvedAddonHost : undefined,
  };
}
