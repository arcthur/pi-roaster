import { join, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import {
  BrewvaRuntime,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions,
} from "@brewva/brewva-runtime";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import { createBrewvaExtension } from "@brewva/brewva-extensions";
import { registerRuntimeCoreEventBridge } from "./session-event-bridge.js";

export interface BrewvaSessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
}

function resolveModel(modelText: string | undefined, registry: ModelRegistry): ReturnType<ModelRegistry["find"]> {
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

export async function createBrewvaSession(options: CreateBrewvaSessionOptions = {}): Promise<BrewvaSessionResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();
  // legacy compat: upstream pi-coding-agent reads PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env["BREWVA_CODING_AGENT_DIR"] = agentDir;

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveModel(options.model, modelRegistry);

  const runtime = new BrewvaRuntime({
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
    extensionFactories: extensionsEnabled ? [createBrewvaExtension({ runtime, registerTools: true })] : [],
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
