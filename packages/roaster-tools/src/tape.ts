import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  ContextBudgetUsage,
  ContextPressureStatus,
  TapeSearchScope,
} from "@pi-roaster/roaster-runtime";
import type { RoasterToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

const TapeSearchScopeSchema = Type.Union([
  Type.Literal("current_phase"),
  Type.Literal("all_phases"),
  Type.Literal("anchors_only"),
]);

function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUsage(value: unknown): ContextBudgetUsage | undefined {
  const usage = value as
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
    return undefined;
  }
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : null,
    contextWindow: usage.contextWindow,
    percent: typeof usage.percent === "number" ? usage.percent : null,
  };
}

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "unknown";
  return `${(ratio * 100).toFixed(1)}%`;
}

function resolveContextAction(level: "none" | "low" | "medium" | "high" | "critical" | "unknown"): string {
  if (level === "critical") return "session_compact_now";
  if (level === "high") return "session_compact_soon";
  return "none";
}

function formatTapeInfoBlock(input: {
  tape: ReturnType<RoasterToolOptions["runtime"]["getTapeStatus"]>;
  pressure: ContextPressureStatus;
}): string {
  const lines = [
    "[TapeInfo]",
    `tape_pressure: ${input.tape.tapePressure}`,
    `tape_entries_total: ${input.tape.totalEntries}`,
    `tape_entries_since_anchor: ${input.tape.entriesSinceAnchor}`,
    `tape_entries_since_checkpoint: ${input.tape.entriesSinceCheckpoint}`,
    `tape_threshold_low: ${input.tape.thresholds.low}`,
    `tape_threshold_medium: ${input.tape.thresholds.medium}`,
    `tape_threshold_high: ${input.tape.thresholds.high}`,
    `last_anchor_name: ${input.tape.lastAnchor?.name ?? "none"}`,
    `last_anchor_id: ${input.tape.lastAnchor?.id ?? "none"}`,
    `last_checkpoint_id: ${input.tape.lastCheckpointId ?? "none"}`,
    `context_pressure: ${input.pressure.level}`,
    `context_usage: ${formatPercent(input.pressure.usageRatio)}`,
    `context_hard_limit: ${formatPercent(input.pressure.hardLimitRatio)}`,
    `required_action: ${resolveContextAction(input.pressure.level)}`,
  ];
  return lines.join("\n");
}

function resolveToolContextUsage(ctx: unknown): ContextBudgetUsage | undefined {
  const usage = (ctx as { getContextUsage?: (() => unknown) | undefined }).getContextUsage?.();
  return normalizeUsage(usage);
}

function toSafeScope(value: unknown): TapeSearchScope {
  if (value === "all_phases" || value === "anchors_only") return value;
  return "current_phase";
}

export function createTapeTools(options: RoasterToolOptions): ToolDefinition<any>[] {
  const tapeHandoff: ToolDefinition<any> = {
    name: "tape_handoff",
    label: "Tape Handoff",
    description: "Create a tape anchor for semantic phase handoff. This does not compact message history.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120 }),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      next_steps: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const handoff = options.runtime.recordTapeHandoff(sessionId, {
        name: params.name,
        summary: params.summary,
        nextSteps: params.next_steps,
      });
      if (!handoff.ok) {
        return textResult(`Tape handoff rejected (${handoff.error ?? "unknown_error"}).`, handoff);
      }

      const status = handoff.tapeStatus ?? options.runtime.getTapeStatus(sessionId);
      const text = [
        "Tape handoff recorded.",
        `name: ${params.name}`,
        `anchor_id: ${handoff.eventId ?? "unknown"}`,
        `tape_pressure: ${status.tapePressure}`,
        `entries_since_anchor: ${status.entriesSinceAnchor}`,
        `total_entries: ${status.totalEntries}`,
      ].join("\n");
      return textResult(text, {
        ok: true,
        anchorId: handoff.eventId ?? null,
        createdAt: handoff.createdAt ?? null,
        tapePressure: status.tapePressure,
        entriesSinceAnchor: status.entriesSinceAnchor,
        totalEntries: status.totalEntries,
      });
    },
  };

  const tapeInfo: ToolDefinition<any> = {
    name: "tape_info",
    label: "Tape Info",
    description: "Show tape status and context pressure for the current session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const tape = options.runtime.getTapeStatus(sessionId);
      const usage =
        resolveToolContextUsage(ctx) ?? options.runtime.getContextUsage(sessionId);
      const pressure = options.runtime.getContextPressureStatus(sessionId, usage);

      return textResult(
        formatTapeInfoBlock({
          tape,
          pressure,
        }),
        {
          ok: true,
          tape,
          context: {
            pressure: pressure.level,
            usageTokens: usage?.tokens ?? null,
            usagePercent: pressure.usageRatio,
          },
        },
      );
    },
  };

  const tapeSearch: ToolDefinition<any> = {
    name: "tape_search",
    label: "Tape Search",
    description: "Search historical tape entries by text query.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 400 }),
      scope: Type.Optional(TapeSearchScopeSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = normalizeQuery(params.query);
      if (!query) {
        return textResult("Tape search rejected (missing_query).", {
          ok: false,
          error: "missing_query",
        });
      }

      const scope = toSafeScope(params.scope);
      const result = options.runtime.searchTape(sessionId, {
        query,
        scope,
        limit: params.limit,
      });

      if (result.matches.length === 0) {
        return textResult(
          [
            "[TapeSearch]",
            `query: ${query}`,
            `scope: ${scope}`,
            `scanned_events: ${result.scannedEvents}`,
            "matches: 0",
          ].join("\n"),
          {
            ok: true,
            ...result,
          },
        );
      }

      const lines = [
        "[TapeSearch]",
        `query: ${query}`,
        `scope: ${scope}`,
        `scanned_events: ${result.scannedEvents}`,
        `matches: ${result.matches.length}`,
      ];
      for (let index = 0; index < result.matches.length; index += 1) {
        const match = result.matches[index];
        if (!match) continue;
        lines.push(
          `${index + 1}. [${match.type}] id=${match.eventId} turn=${match.turn ?? "n/a"} ts=${new Date(match.timestamp).toISOString()}`,
        );
        lines.push(`   ${match.excerpt}`);
      }

      return textResult(lines.join("\n"), {
        ok: true,
        ...result,
      });
    },
  };

  return [tapeHandoff, tapeInfo, tapeSearch];
}
