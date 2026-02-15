import { join, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import { RoasterRuntime, type CreateRoasterSessionOptions } from "@pi-roaster/roaster-runtime";
import { buildRoasterTools } from "@pi-roaster/roaster-tools";
import { createRoasterExtension } from "@pi-roaster/roaster-extensions";

export interface RoasterSessionResult extends CreateAgentSessionResult {
  runtime: RoasterRuntime;
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

export async function createRoasterSession(options: CreateRoasterSessionOptions = {}): Promise<RoasterSessionResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = getAgentDir();

  const authStorage = new AuthStorage(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveModel(options.model, modelRegistry);

  const runtime = new RoasterRuntime({
    cwd,
    configPath: options.configPath,
    config: undefined,
  });

  if (options.activePacks && options.activePacks.length > 0) {
    runtime.config.skills.packs = [...options.activePacks];
    runtime.refreshSkills();
  }

  const settingsManager = SettingsManager.create(cwd, agentDir);

  const extensionsEnabled = options.enableExtensions !== false;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: extensionsEnabled ? [createRoasterExtension({ runtime, registerTools: true })] : [],
  });
  await resourceLoader.reload();

  const customTools = extensionsEnabled ? undefined : buildRoasterTools({ runtime });

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
  runtime.restoreStartupSession(sessionId);
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
