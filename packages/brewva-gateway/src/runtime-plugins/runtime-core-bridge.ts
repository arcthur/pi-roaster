import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createCompletionGuardLifecycle } from "./completion-guard.js";
import { prepareContextComposerSupport } from "./context-composer-support.js";
import { buildContextComposedEventPayload, composeContextBlocks } from "./context-composer.js";
import { applyContextContract } from "./context-contract.js";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  resolveInjectionScopeId,
} from "./context-shared.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { createQualityGateLifecycle } from "./quality-gate.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import { createToolSurfaceLifecycle } from "./tool-surface.js";
import { registerTurnLifecycleAdapter } from "./turn-lifecycle-adapter.js";

const CORE_CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";

export function registerRuntimeCoreBridge(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const toolSurface = createToolSurfaceLifecycle(pi, runtime);
  const qualityGate = createQualityGateLifecycle(runtime);
  const completionGuard = createCompletionGuardLifecycle(pi, runtime);
  hooks.on("input", qualityGate.input);
  hooks.on("tool_call", qualityGate.toolCall);
  registerTurnLifecycleAdapter(pi, {
    beforeAgentStart: [
      toolSurface.beforeAgentStart,
      async (event, ctx) => {
        const rawEvent = event as { prompt?: unknown; systemPrompt?: unknown };
        const rawCtx = ctx as {
          sessionManager: { getSessionId: () => string };
          getContextUsage?: () => unknown;
        };
        const sessionId = rawCtx.sessionManager.getSessionId();
        const usage = coerceContextBudgetUsage(
          typeof rawCtx.getContextUsage === "function" ? rawCtx.getContextUsage() : undefined,
        );
        runtime.context.observeUsage(sessionId, usage);
        const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
        const injection = await runtime.context.buildInjection(
          sessionId,
          prompt,
          usage,
          resolveInjectionScopeId(rawCtx.sessionManager),
        );
        const { gateStatus, pendingCompactionReason, capabilityView } =
          prepareContextComposerSupport({
            runtime,
            pi,
            sessionId,
            prompt,
            usage,
          });
        const composed = composeContextBlocks({
          runtime,
          sessionId,
          gateStatus,
          pendingCompactionReason,
          capabilityView,
          admittedEntries: injection.entries,
          injectionAccepted: injection.accepted,
        });
        runtime.events.record({
          sessionId,
          type: "context_composed",
          payload: buildContextComposedEventPayload(composed, injection.accepted),
        });

        return {
          systemPrompt: applyContextContract(rawEvent.systemPrompt, runtime),
          message: {
            customType: CORE_CONTEXT_INJECTION_MESSAGE_TYPE,
            content: composed.content,
            display: false,
            details: {
              profile: "runtime-core",
              originalTokens: injection.originalTokens,
              finalTokens: injection.finalTokens,
              truncated: injection.truncated,
              gateRequired: gateStatus.required,
              contextComposition: {
                narrativeRatio: composed.metrics.narrativeRatio,
                narrativeTokens: composed.metrics.narrativeTokens,
                constraintTokens: composed.metrics.constraintTokens,
                diagnosticTokens: composed.metrics.diagnosticTokens,
              },
              capabilityView: {
                requested: capabilityView.requested,
                expanded: capabilityView.expanded,
                missing: capabilityView.missing,
              },
            },
          },
        };
      },
    ],
    agentEnd: [completionGuard.agentEnd],
    sessionCompact: [
      (event, ctx) => {
        const rawEvent = event as { fromExtension?: unknown; compactionEntry?: unknown };
        const rawCtx = ctx as {
          sessionManager: { getSessionId: () => string };
          getContextUsage?: () => unknown;
        };
        const sessionId = rawCtx.sessionManager.getSessionId();
        const usage = coerceContextBudgetUsage(
          typeof rawCtx.getContextUsage === "function" ? rawCtx.getContextUsage() : undefined,
        );
        const entryId = extractCompactionEntryId(rawEvent);

        runtime.context.markCompacted(sessionId, {
          fromTokens: null,
          toTokens: usage?.tokens ?? null,
          summary: extractCompactionSummary(rawEvent),
          entryId,
        });
        runtime.events.record({
          sessionId,
          type: "session_compact",
          payload: {
            entryId: entryId ?? null,
            fromExtension: rawEvent.fromExtension === true ? true : undefined,
          },
        });
        return undefined;
      },
    ],
    sessionShutdown: [
      (event, ctx) => {
        void event;
        const sessionId = (
          ctx as { sessionManager: { getSessionId: () => string } }
        ).sessionManager.getSessionId();
        runtime.session.clearState(sessionId);
        return undefined;
      },
      completionGuard.sessionShutdown,
    ],
  });
  registerLedgerWriter(pi, runtime);
  registerToolResultDistiller(pi, runtime);
  hooks.on("tool_result", qualityGate.toolResult);
}

export function createRuntimeCoreBridgeExtension(options: {
  runtime: BrewvaRuntime;
}): ExtensionFactory {
  return (pi) => {
    registerRuntimeCoreBridge(pi, options.runtime);
  };
}
