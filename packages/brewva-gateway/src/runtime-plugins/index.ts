import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  getExactToolGovernanceDescriptor,
  registerToolGovernanceDescriptor,
  sameToolGovernanceDescriptor,
  type BrewvaRuntimeOptions,
} from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
} from "@brewva/brewva-tools";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createCognitiveMetricsLifecycle, registerCognitiveMetrics } from "./cognitive-metrics.js";
import { createCompletionGuardLifecycle, registerCompletionGuard } from "./completion-guard.js";
import { createContextTransformLifecycle, registerContextTransform } from "./context-transform.js";
import { registerDebugLoop } from "./debug-loop.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { createMemoryCuratorLifecycle, registerMemoryCurator } from "./memory-curator.js";
import { createMemoryFormationLifecycle, registerMemoryFormation } from "./memory-formation.js";
import { createNotificationLifecycle, registerNotification } from "./notification.js";
import { createQualityGateLifecycle } from "./quality-gate.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import { createToolSurfaceLifecycle, registerToolSurface } from "./tool-surface.js";
import { registerTurnLifecycleAdapter } from "./turn-lifecycle-adapter.js";

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

function registerLifecycleHandlers(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  profile: BrewvaExtensionProfile | undefined,
  toolDefinitionsByName?: ReadonlyMap<string, ReturnType<typeof buildBrewvaTools>[number]>,
): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const features = resolveProfile(profile);
  const contextTransform = createContextTransformLifecycle(pi, runtime);
  const qualityGate = createQualityGateLifecycle(runtime);
  const toolSurface = createToolSurfaceLifecycle(pi, runtime, {
    dynamicToolDefinitions: toolDefinitionsByName,
  });
  const completionGuard = createCompletionGuardLifecycle(pi, runtime);
  const memoryCurator = features.memory ? createMemoryCuratorLifecycle(runtime) : null;
  const memoryFormation = features.memory ? createMemoryFormationLifecycle(runtime) : null;
  const cognitiveMetrics = features.cognitive ? createCognitiveMetricsLifecycle(runtime) : null;
  const notification = features.cognitive ? createNotificationLifecycle(runtime) : null;

  hooks.on("input", qualityGate.input);
  hooks.on("tool_call", qualityGate.toolCall);
  registerEventStream(pi, runtime);
  registerTurnLifecycleAdapter(pi, {
    sessionStart: cognitiveMetrics ? [cognitiveMetrics.sessionStart] : undefined,
    turnStart: [
      contextTransform.turnStart,
      ...(cognitiveMetrics ? [cognitiveMetrics.turnStart] : []),
    ],
    input: [qualityGate.input],
    context: [contextTransform.context],
    beforeAgentStart: [
      ...(memoryCurator ? [memoryCurator.beforeAgentStart] : []),
      toolSurface.beforeAgentStart,
      contextTransform.beforeAgentStart,
      ...(cognitiveMetrics ? [cognitiveMetrics.beforeAgentStart] : []),
    ],
    toolResult: cognitiveMetrics ? [cognitiveMetrics.toolResult] : undefined,
    toolExecutionEnd: cognitiveMetrics ? [cognitiveMetrics.toolExecutionEnd] : undefined,
    agentEnd: [
      completionGuard.agentEnd,
      ...(memoryFormation ? [memoryFormation.agentEnd] : []),
      ...(notification ? [notification.agentEnd] : []),
    ],
    sessionCompact: [
      contextTransform.sessionCompact,
      ...(memoryFormation ? [memoryFormation.sessionCompact] : []),
    ],
    sessionShutdown: [
      contextTransform.sessionShutdown,
      ...(memoryCurator ? [memoryCurator.sessionShutdown] : []),
      ...(memoryFormation ? [memoryFormation.sessionShutdown] : []),
      completionGuard.sessionShutdown,
      ...(cognitiveMetrics ? [cognitiveMetrics.sessionShutdown] : []),
    ],
  });
  registerLedgerWriter(pi, runtime);
  registerToolResultDistiller(pi, runtime);
  hooks.on("tool_result", qualityGate.toolResult);
  if (features.debug) {
    registerDebugLoop(pi, runtime);
  }
}

export function createBrewvaExtension(
  options: CreateBrewvaExtensionOptions = {},
): ExtensionFactory {
  return (pi) => {
    const runtime =
      options.runtime ??
      new BrewvaRuntime({
        ...options,
        governancePort: options.governancePort ?? createTrustedLocalGovernancePort(),
      });
    const shouldRegisterTools = options.registerTools !== false;
    const allTools = shouldRegisterTools ? buildBrewvaTools({ runtime }) : [];
    const toolDefinitionsByName = shouldRegisterTools
      ? new Map(allTools.map((tool) => [tool.name, tool] as const))
      : undefined;

    if (shouldRegisterTools) {
      for (const tool of allTools) {
        const metadata = getBrewvaToolMetadata(tool);
        if (metadata?.governance) {
          const exactGovernance = getExactToolGovernanceDescriptor(tool.name);
          if (sameToolGovernanceDescriptor(exactGovernance, metadata.governance)) {
            continue;
          }
          registerToolGovernanceDescriptor(tool.name, metadata.governance);
        }
      }
      for (const tool of allTools) {
        if (getBrewvaToolSurface(tool.name) !== "base") continue;
        pi.registerTool(tool);
      }
    }

    registerLifecycleHandlers(pi, runtime, options.profile, toolDefinitionsByName);
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
export { registerContextTransform } from "./context-transform.js";
export { registerTurnLifecycleAdapter } from "./turn-lifecycle-adapter.js";
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
export { registerToolSurface, type ToolSurfaceRuntime } from "./tool-surface.js";
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
