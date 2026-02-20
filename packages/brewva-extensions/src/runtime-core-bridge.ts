import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { registerLedgerWriter } from "./ledger-writer.js";
import { registerQualityGate } from "./quality-gate.js";

function extractCompactionSummary(input: unknown): string | undefined {
  const event = input as
    | {
        compactionEntry?: {
          summary?: unknown;
          content?: unknown;
          text?: unknown;
        };
      }
    | undefined;
  const entry = event?.compactionEntry;
  if (!entry) return undefined;

  const candidates = [entry.summary, entry.content, entry.text];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function extractCompactionEntryId(input: unknown): string | undefined {
  const event = input as
    | {
        compactionEntry?: {
          id?: unknown;
        };
      }
    | undefined;
  const id = event?.compactionEntry?.id;
  if (typeof id !== "string") return undefined;
  const normalized = id.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function registerRuntimeCoreBridge(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  registerQualityGate(pi, runtime);
  registerLedgerWriter(pi, runtime);

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    const entryId = extractCompactionEntryId(event);

    runtime.markContextCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId,
    });
    runtime.recordEvent({
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
    runtime.clearSessionState(sessionId);
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
