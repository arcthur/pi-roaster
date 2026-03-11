import { BrewvaRuntime, type BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { buildBrewvaTools, getBrewvaToolSurface } from "@brewva/brewva-tools";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { registerCognitiveMetrics } from "./cognitive-metrics.js";
import { registerCompletionGuard } from "./completion-guard.js";
import { registerContextTransform } from "./context-transform.js";
import { registerDebugLoop } from "./debug-loop.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { registerMemoryAdaptation } from "./memory-adaptation.js";
import { registerMemoryCurator } from "./memory-curator.js";
import { registerMemoryFormation } from "./memory-formation.js";
import { registerNotification } from "./notification.js";
import { registerQualityGate } from "./quality-gate.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import { registerToolSurface } from "./tool-surface.js";

export interface CreateBrewvaExtensionOptions extends BrewvaRuntimeOptions {
  runtime?: BrewvaRuntime;
  registerTools?: boolean;
  profile?: BrewvaExtensionProfile;
}

export type BrewvaExtensionProfile = "core" | "memory" | "debug" | "full";

function resolveProfile(profile: BrewvaExtensionProfile | undefined): {
  memory: boolean;
  debug: boolean;
  cognitive: boolean;
} {
  switch (profile ?? "core") {
    case "memory":
      return { memory: true, debug: false, cognitive: false };
    case "debug":
      return { memory: false, debug: true, cognitive: false };
    case "full":
      return { memory: true, debug: true, cognitive: true };
    case "core":
    default:
      return { memory: false, debug: false, cognitive: false };
  }
}

function registerCoreHandlers(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  toolDefinitionsByName?: ReadonlyMap<string, ReturnType<typeof buildBrewvaTools>[number]>,
): void {
  registerEventStream(pi, runtime);
  registerToolSurface(pi, runtime, {
    dynamicToolDefinitions: toolDefinitionsByName,
  });
  registerContextTransform(pi, runtime);
  registerQualityGate(pi, runtime);
  registerLedgerWriter(pi, runtime);
  registerToolResultDistiller(pi, runtime);
  registerCompletionGuard(pi, runtime);
}

function registerOptionalHandlers(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  profile: BrewvaExtensionProfile | undefined,
): void {
  const features = resolveProfile(profile);
  if (features.memory) {
    registerMemoryCurator(pi, runtime);
    registerMemoryFormation(pi, runtime);
    registerMemoryAdaptation(pi, runtime);
  }
  if (features.debug) {
    registerDebugLoop(pi, runtime);
  }
  if (features.cognitive) {
    registerCognitiveMetrics(pi, runtime);
    registerNotification(pi, runtime);
  }
}

export function createBrewvaExtension(
  options: CreateBrewvaExtensionOptions = {},
): ExtensionFactory {
  return (pi) => {
    const runtime = options.runtime ?? new BrewvaRuntime(options);
    const shouldRegisterTools = options.registerTools !== false;
    const allTools = shouldRegisterTools ? buildBrewvaTools({ runtime }) : [];
    const toolDefinitionsByName = shouldRegisterTools
      ? new Map(allTools.map((tool) => [tool.name, tool] as const))
      : undefined;

    if (shouldRegisterTools) {
      for (const tool of allTools) {
        if (getBrewvaToolSurface(tool.name) !== "base") continue;
        pi.registerTool(tool);
      }
    }

    registerCoreHandlers(pi, runtime, toolDefinitionsByName);
    registerOptionalHandlers(pi, runtime, options.profile);
  };
}

export function brewvaExtension(options: CreateBrewvaExtensionOptions = {}): ExtensionFactory {
  return createBrewvaExtension(options);
}

export {
  createRuntimeCoreBridgeExtension,
  registerRuntimeCoreBridge,
} from "./runtime-core-bridge.js";
export { registerMemoryCurator } from "./memory-curator.js";
export { registerMemoryFormation } from "./memory-formation.js";
export { registerCognitiveMetrics } from "./cognitive-metrics.js";
export {
  deriveMemoryFormationGuidance,
  createEmptyMemoryAdaptationPolicy,
  flushMemoryAdaptationPolicy,
  rankMemoryHydrationCandidates,
  readMemoryAdaptationPolicy,
  registerMemoryAdaptation,
  resolveMemoryAdaptationPolicyPath,
  type MemoryAdaptationCandidate,
  type MemoryAdaptationPacketStats,
  type MemoryAdaptationPolicy,
  type MemoryAdaptationStats,
  type MemoryFormationGuidance,
  type MemoryHydrationStrategy,
} from "./memory-adaptation.js";
export { registerContextTransform } from "./context-transform.js";
export {
  buildProactivitySelectionText,
  readLatestProactivityWakeup,
  recordProactivityWakeup,
  type ProactivityTriggerContext,
  type ProactivityTriggerSource,
} from "./proactivity-context.js";
export {
  planHeartbeatWake,
  type ProactivityRuleInput,
  type ProactivityWakeMode,
  type ProactivityWakePlan,
  type ProactivityWakeSignal,
} from "./proactivity-engine.js";
export {
  composeContextBlocks,
  type ComposedContextBlock,
  type ContextBlockCategory,
  type ContextComposerInput,
  type ContextComposerMetrics,
  type ContextComposerResult,
} from "./context-composer.js";
export {
  buildCapabilityView,
  type CapabilityAccessDecision,
  type BuildCapabilityViewInput,
  type BuildCapabilityViewResult,
} from "./capability-view.js";
export { registerEventStream } from "./event-stream.js";
export { registerQualityGate } from "./quality-gate.js";
export { registerLedgerWriter } from "./ledger-writer.js";
export { registerDebugLoop } from "./debug-loop.js";
export { registerCompletionGuard } from "./completion-guard.js";
export { registerNotification } from "./notification.js";
export { registerToolSurface } from "./tool-surface.js";
export { registerToolResultDistiller } from "./tool-result-distiller.js";
export { applyContextContract, buildContextContractBlock } from "./context-contract.js";
export { createRuntimeChannelTurnBridge } from "./channel-turn-bridge.js";
export { createRuntimeTelegramChannelBridge } from "./telegram-channel-bridge.js";
export {
  CHARS_PER_TOKEN,
  distillToolOutput,
  estimateTokens,
  type ToolOutputDistillation,
} from "./tool-output-distiller.js";
export {
  extractToolResultText,
  resolveToolDisplayStatus,
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
  type ResolveToolDisplayTextInput,
  type ToolDisplayVerdict,
} from "./tool-output-display.js";
