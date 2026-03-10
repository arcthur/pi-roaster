import { BrewvaRuntime, type BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { buildBrewvaTools } from "@brewva/brewva-tools";
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
import { registerScanConvergenceGuard } from "./scan-convergence-guard.js";
import { registerToolSurface } from "./tool-surface.js";

export interface CreateBrewvaExtensionOptions extends BrewvaRuntimeOptions {
  runtime?: BrewvaRuntime;
  registerTools?: boolean;
}

function registerAllHandlers(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  registerEventStream(pi, runtime);
  registerToolSurface(pi, runtime);
  registerMemoryCurator(pi, runtime);
  registerMemoryFormation(pi, runtime);
  registerContextTransform(pi, runtime);
  registerCognitiveMetrics(pi, runtime);
  registerMemoryAdaptation(pi, runtime);
  registerScanConvergenceGuard(pi, runtime);
  registerQualityGate(pi, runtime);
  registerDebugLoop(pi, runtime);
  registerLedgerWriter(pi, runtime);
  registerCompletionGuard(pi, runtime);
  registerNotification(pi, runtime);
}

export function createBrewvaExtension(
  options: CreateBrewvaExtensionOptions = {},
): ExtensionFactory {
  return (pi) => {
    const runtime = options.runtime ?? new BrewvaRuntime(options);

    if (options.registerTools !== false) {
      const tools = buildBrewvaTools({ runtime });
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    }

    registerAllHandlers(pi, runtime);
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
export { registerScanConvergenceGuard } from "./scan-convergence-guard.js";
export { registerLedgerWriter } from "./ledger-writer.js";
export { registerDebugLoop } from "./debug-loop.js";
export { registerCompletionGuard } from "./completion-guard.js";
export { registerNotification } from "./notification.js";
export { registerToolSurface } from "./tool-surface.js";
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
  resolveToolDisplayText,
  type ResolveToolDisplayTextInput,
} from "./tool-output-display.js";
