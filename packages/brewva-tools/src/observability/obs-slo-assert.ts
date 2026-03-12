import {
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../types.js";
import { inconclusiveTextResult, textResult } from "../utils/result.js";
import { getSessionId } from "../utils/session.js";
import { defineBrewvaTool } from "../utils/tool.js";
import {
  OBS_AGGREGATION_SCHEMA,
  OBS_OPERATOR_SCHEMA,
  OBS_TYPES_SCHEMA,
  OBS_WHERE_SCHEMA,
  buildRawArtifactText,
  compareObservabilityValue,
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
} from "./shared.js";

const DEFAULT_MIN_SAMPLES = 1;
const MAX_MIN_SAMPLES = 10_000;

function resolveNextStep(verdict: "pass" | "fail" | "inconclusive"): string {
  if (verdict === "pass") {
    return "Reuse this assertion as supporting evidence for the current task.";
  }
  if (verdict === "fail") {
    return "Inspect query_ref and address the violating events before claiming completion.";
  }
  return "Collect more samples or widen the window before making a completion claim.";
}

function buildBlockedText(input: { recentSingleQueryCalls: number }): string {
  return [
    "[ObsSloAssert]",
    "Blocked due to high-frequency single-query calls.",
    "Window: 90s",
    `Recent single-query calls: ${input.recentSingleQueryCalls + 1}`,
    "Retry after the throttle window or reduce repeated single-assert calls.",
  ].join("\n");
}

export function createObsSloAssertTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "obs_slo_assert",
    label: "Observability SLO Assert",
    description:
      "Assert a metric over current-session runtime events and return a pass/fail verdict.",
    parameters: Type.Object({
      types: OBS_TYPES_SCHEMA,
      where: OBS_WHERE_SCHEMA,
      metric: Type.String({ minLength: 1, maxLength: 120 }),
      aggregation: OBS_AGGREGATION_SCHEMA,
      operator: OBS_OPERATOR_SCHEMA,
      threshold: Type.Number(),
      windowMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_080 })),
      minSamples: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MIN_SAMPLES })),
      severity: Type.Optional(
        Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const throttleState = computeObservabilityThrottle({
        events: getObservabilityThrottleEvents(
          options.runtime,
          sessionId,
          OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
        ),
        requestedLimit: 1,
      });
      if (throttleState.level === "blocked") {
        options.runtime.events.record?.({
          sessionId,
          type: OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
          payload: {
            toolName: "obs_slo_assert",
            queryCount: 1,
            types: normalizeTypeList(params.types),
            where: normalizeWhere(params.where) ?? {},
            metric: params.metric.trim(),
            aggregation: params.aggregation,
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

      const minSamples = normalizePositiveInteger(params.minSamples, {
        fallback: DEFAULT_MIN_SAMPLES,
        min: 1,
        max: MAX_MIN_SAMPLES,
      });
      const spec = {
        types: normalizeTypeList(params.types),
        where: normalizeWhere(params.where) ?? {},
        windowMinutes: normalizeWindowMinutes(params.windowMinutes),
        last: null,
        metric: params.metric.trim(),
        aggregation: params.aggregation,
      } as const;
      const query = runObservabilityQuery(options.runtime, sessionId, spec);
      const workspaceRoot = resolveWorkspaceRoot(options.runtime, ctx);
      const generatedAt = Date.now();

      let verdict: "pass" | "fail" | "inconclusive";
      if (query.sampleSize < minSamples || query.observedValue === null) {
        verdict = "inconclusive";
      } else if (
        compareObservabilityValue(query.observedValue, params.operator, params.threshold)
      ) {
        verdict = "pass";
      } else {
        verdict = "fail";
      }

      const assertionRecord = {
        kind: "slo_assert",
        spec: {
          types: spec.types,
          where: spec.where,
          metric: spec.metric,
          aggregation: spec.aggregation,
          operator: params.operator,
          threshold: params.threshold,
          windowMinutes: spec.windowMinutes,
          minSamples,
        },
        observedValue: query.observedValue,
        sampleSize: query.sampleSize,
        queryRef: null as string | null,
        severity: params.severity ?? "warn",
      };

      const rawArtifactText = buildRawArtifactText({
        schema: "brewva.observability.assertion.v1",
        sessionId,
        toolName: "obs_slo_assert",
        generatedAt,
        spec: assertionRecord.spec,
        result: {
          verdict,
          observedValue: query.observedValue,
          sampleSize: query.sampleSize,
          matchCount: query.matchCount,
          nextStep: resolveNextStep(verdict),
          throttleLevel: throttleState.level,
        },
        events: query.events,
      });
      const artifactOverride = persistObservabilityArtifact({
        workspaceRoot,
        sessionId,
        toolCallId,
        toolName: "obs_slo_assert",
        rawText: rawArtifactText,
        timestamp: generatedAt,
      });
      assertionRecord.queryRef = artifactOverride?.artifactRef ?? null;

      options.runtime.events.record?.({
        sessionId,
        type: OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
        payload: {
          toolName: "obs_slo_assert",
          queryCount: 1,
          types: spec.types,
          where: spec.where,
          metric: spec.metric,
          aggregation: spec.aggregation,
          windowMinutes: spec.windowMinutes,
          matchCount: query.matchCount,
          queryRef: artifactOverride?.artifactRef ?? null,
          throttleLevel: throttleState.level,
          blocked: false,
        },
      });
      options.runtime.events.record?.({
        sessionId,
        type: OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
        payload: {
          verdict,
          metric: spec.metric,
          aggregation: spec.aggregation,
          operator: params.operator,
          threshold: params.threshold,
          observedValue: query.observedValue,
          sampleSize: query.sampleSize,
          queryRef: artifactOverride?.artifactRef ?? null,
        },
      });

      const nextStep = resolveNextStep(verdict);
      const lines = [
        "[ObsSloAssert]",
        `verdict: ${verdict}`,
        `observed_value: ${formatMetricValue(query.observedValue)}`,
        `threshold: ${formatMetricValue(params.threshold)}`,
        `sample_size: ${query.sampleSize}`,
        `window_minutes: ${spec.windowMinutes ?? "all"}`,
        `query_ref: ${artifactOverride?.artifactRef ?? "none"}`,
        `next_step: ${nextStep}`,
      ];

      return textResult(lines.join("\n"), {
        ok: true,
        verdict,
        queryRef: artifactOverride?.artifactRef ?? null,
        observedValue: query.observedValue,
        sampleSize: query.sampleSize,
        nextStep,
        artifactOverride: artifactOverride ?? null,
        observabilityAssertion: assertionRecord,
      });
    },
  });
}
