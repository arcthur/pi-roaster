import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { registerCompletionGuard } from "./completion-guard.js";
import { prepareContextComposerSupport } from "./context-composer-support.js";
import { buildContextComposedEventPayload, composeContextBlocks } from "./context-composer.js";
import { applyContextContract } from "./context-contract.js";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  resolveInjectionScopeId,
} from "./context-shared.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { registerQualityGate } from "./quality-gate.js";
import { registerToolResultDistiller } from "./tool-result-distiller.js";
import { registerToolSurface } from "./tool-surface.js";

const CORE_CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";

export function registerRuntimeCoreBridge(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  registerToolSurface(pi, runtime);
  registerQualityGate(pi, runtime);
  registerLedgerWriter(pi, runtime);
  registerToolResultDistiller(pi, runtime);
  registerCompletionGuard(pi, runtime);

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);
    const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? event.prompt : "";
    const injection = await runtime.context.buildInjection(
      sessionId,
      prompt,
      usage,
      resolveInjectionScopeId(ctx.sessionManager),
    );
    const { gateStatus, pendingCompactionReason, capabilityView } = prepareContextComposerSupport({
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
      systemPrompt: applyContextContract(
        (event as { systemPrompt?: unknown }).systemPrompt,
        runtime,
      ),
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
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    const entryId = extractCompactionEntryId(event);

    runtime.context.markCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId,
    });
    runtime.events.record({
      sessionId,
      type: "session_compact",
      payload: {
        entryId: entryId ?? null,
        fromExtension:
          (event as { fromExtension?: unknown }).fromExtension === true ? true : undefined,
      },
    });
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    runtime.session.clearState(sessionId);
    return undefined;
  });
}

export function createRuntimeCoreBridgeExtension(options: {
  runtime: BrewvaRuntime;
}): ExtensionFactory {
  return (pi) => {
    registerRuntimeCoreBridge(pi, options.runtime);
  };
}
