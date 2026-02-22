import { join, resolve } from "node:path";
import { createBrewvaExtension, createRuntimeCoreBridgeExtension } from "@brewva/brewva-extensions";
import {
  BrewvaRuntime,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions,
  recordAssistantUsageFromMessage,
} from "@brewva/brewva-runtime";
import { buildBrewvaTools } from "@brewva/brewva-tools";
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
} from "@mariozechner/pi-coding-agent";

export interface GatewaySessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
}

export interface CreateGatewaySessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime;
}

function resolveModel(
  modelText: string | undefined,
  registry: ModelRegistry,
): ReturnType<ModelRegistry["find"]> {
  if (!modelText) return undefined;
  const parts = modelText.split("/");
  if (parts.length !== 2) return undefined;

  const provider = parts[0];
  const modelId = parts[1];
  if (!provider || !modelId) return undefined;

  return registry.find(provider, modelId);
}

function applyRuntimeUiSettings(
  settingsManager: SettingsManager,
  uiConfig: BrewvaRuntime["config"]["ui"],
): void {
  settingsManager.applyOverrides({
    quietStartup: uiConfig.quietStartup,
    collapseChangelog: uiConfig.collapseChangelog,
  });
}

function registerRuntimeCoreEventBridge(
  runtime: BrewvaRuntime,
  session: GatewaySessionResult["session"],
): () => void {
  let turnIndex = 0;

  return session.subscribe((event: AgentSessionEvent) => {
    const sessionId = session.sessionManager.getSessionId();

    switch (event.type) {
      case "agent_start":
        turnIndex = 0;
        runtime.recordEvent({
          sessionId,
          type: "agent_start",
        });
        break;
      case "turn_start":
        runtime.onTurnStart(sessionId, turnIndex);
        runtime.recordEvent({
          sessionId,
          type: "turn_start",
          turn: turnIndex,
        });
        break;
      case "turn_end": {
        const toolResults = Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;
        runtime.recordEvent({
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
      case "agent_end":
        runtime.recordEvent({
          sessionId,
          type: "agent_end",
        });
        break;
      default:
        break;
    }
  });
}

export async function createGatewaySession(
  options: CreateGatewaySessionOptions = {},
): Promise<GatewaySessionResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveModel(options.model, modelRegistry);

  const runtime =
    options.runtime ??
    new BrewvaRuntime({
      cwd,
      configPath: options.configPath,
      config: undefined,
    });

  if (options.activePacks && options.activePacks.length > 0) {
    runtime.config.skills.packs = [...options.activePacks];
    runtime.refreshSkills();
  }

  const settingsManager = SettingsManager.create(cwd, agentDir);
  applyRuntimeUiSettings(settingsManager, runtime.config.ui);

  const extensionsEnabled = options.enableExtensions !== false;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: extensionsEnabled
      ? [createBrewvaExtension({ runtime, registerTools: true })]
      : [createRuntimeCoreBridgeExtension({ runtime })],
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
    model: selectedModel,
    tools: [readTool, editTool, writeTool],
    customTools,
  });

  const sessionId = sessionResult.session.sessionManager.getSessionId();
  if (!extensionsEnabled) {
    runtime.recordEvent({
      sessionId,
      type: "session_start",
      payload: { cwd },
    });
    registerRuntimeCoreEventBridge(runtime, sessionResult.session);
  }

  runtime.recordEvent({
    sessionId,
    type: "session_bootstrap",
    payload: {
      cwd,
      extensionsEnabled,
    },
  });

  return {
    ...sessionResult,
    runtime,
  };
}
