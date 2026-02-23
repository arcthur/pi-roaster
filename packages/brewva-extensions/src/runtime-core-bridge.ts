import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { registerLedgerWriter } from "./ledger-writer.js";
import { registerQualityGate } from "./quality-gate.js";

const CORE_CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-core-context-injection";
const CORE_CONTEXT_CONTRACT_MARKER = "[Brewva Core Context Contract]";

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "unknown";
  return `${(ratio * 100).toFixed(1)}%`;
}

function buildCoreContextContract(runtime: BrewvaRuntime): string {
  const tapeThresholds = runtime.events.getTapePressureThresholds();
  const highThresholdPercent = formatPercent(runtime.context.getCompactionThresholdRatio());
  const hardLimitPercent = formatPercent(runtime.context.getHardLimitRatio());

  return [
    CORE_CONTEXT_CONTRACT_MARKER,
    "Autonomy controls available in this profile:",
    "- use `tape_handoff` for semantic handoff boundaries.",
    "- use `tape_info` to inspect tape/context pressure.",
    "- use `tape_search` for historical recall from event tape.",
    "- use `session_compact` to reduce message buffer pressure.",
    "Hard rules:",
    "- `tape_handoff` does not reduce message tokens.",
    "- `session_compact` does not change tape semantics.",
    `- tape_pressure thresholds: low=${tapeThresholds.low}, medium=${tapeThresholds.medium}, high=${tapeThresholds.high}.`,
    `- compact soon when context_pressure >= high (${highThresholdPercent}).`,
    `- compact immediately when context_pressure == critical (${hardLimitPercent}).`,
  ].join("\n");
}

function applyCoreContextContract(systemPrompt: unknown, runtime: BrewvaRuntime): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(CORE_CONTEXT_CONTRACT_MARKER)) return base;
  const contract = buildCoreContextContract(runtime);
  if (!base.trim()) return contract;
  return `${base}\n\n${contract}`;
}

function buildCoreStatusBlock(runtime: BrewvaRuntime, sessionId: string): string {
  const tapeStatus = runtime.events.getTapeStatus(sessionId);
  const gate = runtime.context.getCompactionGateStatus(sessionId);
  const action = gate.required ? "session_compact_now" : "none";

  return [
    "[CoreTapeStatus]",
    `tape_pressure: ${tapeStatus.tapePressure}`,
    `tape_entries_total: ${tapeStatus.totalEntries}`,
    `tape_entries_since_anchor: ${tapeStatus.entriesSinceAnchor}`,
    `tape_entries_since_checkpoint: ${tapeStatus.entriesSinceCheckpoint}`,
    `last_anchor_name: ${tapeStatus.lastAnchor?.name ?? "none"}`,
    `last_anchor_id: ${tapeStatus.lastAnchor?.id ?? "none"}`,
    `context_pressure: ${gate.pressure.level}`,
    `context_usage: ${formatPercent(gate.pressure.usageRatio)}`,
    `context_hard_limit: ${formatPercent(gate.pressure.hardLimitRatio)}`,
    `recent_compact_performed: ${gate.recentCompaction ? "true" : "false"}`,
    `recent_compaction_window_turns: ${gate.windowTurns}`,
    `required_action: ${action}`,
  ].join("\n");
}

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

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);

    return {
      systemPrompt: applyCoreContextContract(
        (event as { systemPrompt?: unknown }).systemPrompt,
        runtime,
      ),
      message: {
        customType: CORE_CONTEXT_INJECTION_MESSAGE_TYPE,
        content: buildCoreStatusBlock(runtime, sessionId),
        display: false,
        details: {
          profile: "runtime-core",
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
