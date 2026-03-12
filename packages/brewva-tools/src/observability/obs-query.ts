import { OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../types.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../utils/result.js";
import { getSessionId } from "../utils/session.js";
import { defineBrewvaTool } from "../utils/tool.js";
import {
  OBS_AGGREGATION_SCHEMA,
  OBS_TYPES_SCHEMA,
  OBS_WHERE_SCHEMA,
  buildRawArtifactText,
  computeObservabilityThrottle,
  formatMetricValue,
  getObservabilityThrottleEvents,
  normalizePositiveInteger,
  normalizeTypeList,
  normalizeWhere,
  normalizeWindowMinutes,
  persistObservabilityArtifact,
  resolveWorkspaceRoot,
  runObservabilityQuery,
  summarizeEvent,
} from "./shared.js";

const DEFAULT_LAST = 25;
const MAX_LAST = 200;

function buildBlockedText(input: { recentSingleQueryCalls: number }): string {
  return [
    "[ObsQuery]",
    "Blocked due to high-frequency single-query calls.",
    "Window: 90s",
    `Recent single-query calls: ${input.recentSingleQueryCalls + 1}`,
    "Use broader windows or batch your analysis in fewer calls.",
  ].join("\n");
}

export function createObsQueryTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "obs_query",
    label: "Observability Query",
    description:
      "Query current-session runtime events with structured filters and optional metrics.",
    promptSnippet: "Query current-session runtime events with filters or aggregate metrics.",
    promptGuidelines: [
      "Use this for session telemetry and event analysis, not for filesystem or source inspection.",
    ],
    parameters: Type.Object({
      types: OBS_TYPES_SCHEMA,
      where: OBS_WHERE_SCHEMA,
      windowMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_080 })),
      last: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LAST })),
      metric: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      aggregation: Type.Optional(OBS_AGGREGATION_SCHEMA),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const metric =
        typeof params.metric === "string" && params.metric.trim().length > 0
          ? params.metric.trim()
          : null;
      const aggregation = params.aggregation ?? null;
      if ((metric === null) !== (aggregation === null)) {
        return failTextResult("obs_query rejected (metric_and_aggregation_must_be_paired).", {
          ok: false,
          error: "metric_and_aggregation_must_be_paired",
        });
      }

      const requestedLast = normalizePositiveInteger(params.last, {
        fallback: DEFAULT_LAST,
        min: 1,
        max: MAX_LAST,
      });
      const throttleState = computeObservabilityThrottle({
        events: getObservabilityThrottleEvents(
          options.runtime,
          sessionId,
          OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
        ),
        requestedLimit: requestedLast,
      });
      if (throttleState.level === "blocked") {
        options.runtime.events.record?.({
          sessionId,
          type: OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
          payload: {
            toolName: "obs_query",
            queryCount: 1,
            types: normalizeTypeList(params.types),
            where: normalizeWhere(params.where) ?? {},
            metric,
            aggregation,
            windowMinutes: normalizeWindowMinutes(params.windowMinutes),
            matchCount: 0,
            queryRef: null,
            throttleLevel: throttleState.level,
            blocked: true,
            recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
          },
        });
        return inconclusiveTextResult(buildBlockedText(throttleState), {
          ok: false,
          blocked: true,
          throttleLevel: throttleState.level,
          recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
        });
      }

      const spec = {
        types: normalizeTypeList(params.types),
        where: normalizeWhere(params.where) ?? {},
        windowMinutes: normalizeWindowMinutes(params.windowMinutes),
        last: throttleState.effectiveLimit,
        metric,
        aggregation,
      } as const;
      const query = runObservabilityQuery(options.runtime, sessionId, spec);
      const workspaceRoot = resolveWorkspaceRoot(options.runtime, ctx);
      const generatedAt = Date.now();
      const rawArtifactText = buildRawArtifactText({
        schema: "brewva.observability.query.v1",
        sessionId,
        toolName: "obs_query",
        generatedAt,
        spec,
        result: {
          matchCount: query.matchCount,
          sampleSize: query.sampleSize,
          observedValue: query.observedValue,
          throttleLevel: throttleState.level,
        },
        events: query.events,
      });
      const artifactOverride = persistObservabilityArtifact({
        workspaceRoot,
        sessionId,
        toolCallId,
        toolName: "obs_query",
        rawText: rawArtifactText,
        timestamp: generatedAt,
      });

      const lines = [
        "[ObsQuery]",
        `match_count: ${query.matchCount}`,
        `query_ref: ${artifactOverride?.artifactRef ?? "none"}`,
        `throttle: ${throttleState.level}`,
      ];
      if (metric && aggregation) {
        lines.push(
          `metric: ${metric}`,
          `aggregation: ${aggregation}`,
          `observed_value: ${formatMetricValue(query.observedValue)}`,
          `sample_size: ${query.sampleSize}`,
        );
      } else {
        const sampleSummary = query.events.slice(0, 3).map(summarizeEvent);
        if (sampleSummary.length > 0) {
          lines.push(`sample_events: ${sampleSummary.join(" | ")}`);
        } else {
          lines.push("sample_events: none");
        }
      }

      options.runtime.events.record?.({
        sessionId,
        type: OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
        payload: {
          toolName: "obs_query",
          queryCount: 1,
          types: spec.types,
          where: spec.where,
          metric,
          aggregation,
          windowMinutes: spec.windowMinutes,
          matchCount: query.matchCount,
          queryRef: artifactOverride?.artifactRef ?? null,
          throttleLevel: throttleState.level,
          blocked: false,
        },
      });

      return textResult(lines.join("\n"), {
        ok: true,
        queryRef: artifactOverride?.artifactRef ?? null,
        matchCount: query.matchCount,
        observedValue: query.observedValue,
        sampleSize: query.sampleSize,
        throttleLevel: throttleState.level,
        artifactOverride,
      });
    },
  });
}
