import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolRuntime } from "../types.js";

const DEFAULT_ARTIFACT_DIR = ".orchestrator/tool-output-artifacts";
const SEARCH_THROTTLE_WINDOW_MS = 90_000;
const SEARCH_THROTTLE_REDUCE_AFTER = 4;
const SEARCH_THROTTLE_BLOCK_AFTER = 10;
const SEARCH_THROTTLE_EVENT_LOOKBACK = 120;

export const OBS_FILTER_VALUE_SCHEMA = Type.Union([
  Type.String({ maxLength: 240 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const OBS_WHERE_SCHEMA = Type.Optional(
  Type.Record(Type.String({ minLength: 1, maxLength: 80 }), OBS_FILTER_VALUE_SCHEMA),
);

export const OBS_TYPES_SCHEMA = Type.Optional(
  Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
    maxItems: 24,
  }),
);

export const OBS_AGGREGATION_SCHEMA = Type.Union([
  Type.Literal("count"),
  Type.Literal("min"),
  Type.Literal("max"),
  Type.Literal("avg"),
  Type.Literal("p50"),
  Type.Literal("p95"),
  Type.Literal("latest"),
]);

export const OBS_OPERATOR_SCHEMA = Type.Union([
  Type.Literal("<"),
  Type.Literal("<="),
  Type.Literal(">"),
  Type.Literal(">="),
  Type.Literal("=="),
  Type.Literal("!="),
]);

export type ObservabilityFilterValue = string | number | boolean | null;

export type ObservabilityAggregation = "count" | "min" | "max" | "avg" | "p50" | "p95" | "latest";

export type ObservabilityOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface ObservabilityQuerySpec {
  types: string[];
  where: Record<string, ObservabilityFilterValue>;
  windowMinutes: number | null;
  last: number | null;
  metric: string | null;
  aggregation: ObservabilityAggregation | null;
}

export interface ObservabilityArtifactOverride {
  artifactRef: string;
  rawChars: number;
  rawBytes: number;
  sha256: string;
}

export interface ObservabilityQueryResult {
  events: BrewvaEventRecord[];
  matchCount: number;
  sampleSize: number;
  observedValue: number | null;
}

export interface ObservabilityThrottleState {
  level: "normal" | "limited" | "blocked";
  effectiveLimit: number;
  recentSingleQueryCalls: number;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function sanitizeFileSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-");
  const compact = normalized.replaceAll(/-+/g, "-").replaceAll(/^-+|-+$/g, "");
  return compact || "unknown";
}

export function resolveWorkspaceRoot(runtime: BrewvaToolRuntime, ctx: ExtensionContext): string {
  const cwd = (ctx as { cwd?: unknown }).cwd;
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    return resolve(cwd);
  }
  if (typeof runtime.cwd === "string" && runtime.cwd.trim().length > 0) {
    return resolve(runtime.cwd);
  }
  return process.cwd();
}

export function normalizeTypeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .toSorted();
}

export function normalizeWhere(
  value: unknown,
): Record<string, ObservabilityFilterValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, ObservabilityFilterValue> = {};
  for (const key of Object.keys(input).toSorted()) {
    const raw = input[key];
    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw === null
    ) {
      output[key] = raw;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function normalizePositiveInteger(
  value: unknown,
  defaults: { fallback: number; min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaults.fallback;
  }
  const normalized = Math.floor(value);
  return Math.max(defaults.min, Math.min(defaults.max, normalized));
}

export function normalizeWindowMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.min(7 * 24 * 60, Math.floor(value)));
}

function payloadMatchesWhere(
  payload: Record<string, unknown> | undefined,
  where: Record<string, ObservabilityFilterValue>,
): boolean {
  if (Object.keys(where).length === 0) return true;
  if (!payload) return false;

  for (const [key, expected] of Object.entries(where)) {
    const actual = payload[key];
    if (expected === null) {
      if (actual !== null) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function extractMetricValues(
  events: BrewvaEventRecord[],
  metric: string | null,
): Array<{ event: BrewvaEventRecord; value: number }> {
  if (!metric) return [];

  const rows: Array<{ event: BrewvaEventRecord; value: number }> = [];
  for (const event of events) {
    const payload = event.payload;
    const raw = payload?.[metric];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      rows.push({ event, value: raw });
    }
  }
  return rows;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const position = Math.ceil(sorted.length * ratio) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, position));
  return sorted[index] ?? null;
}

export function aggregateMetricValues(
  values: number[],
  aggregation: ObservabilityAggregation,
): number | null {
  if (aggregation === "count") {
    return values.length;
  }
  if (values.length === 0) return null;
  if (aggregation === "min") return Math.min(...values);
  if (aggregation === "max") return Math.max(...values);
  if (aggregation === "avg") {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (aggregation === "p50") {
    return percentile(values, 0.5);
  }
  if (aggregation === "p95") {
    return percentile(values, 0.95);
  }
  return values[values.length - 1] ?? null;
}

export function runObservabilityQuery(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  spec: ObservabilityQuerySpec,
  now = Date.now(),
): ObservabilityQueryResult {
  const typeSet = new Set(spec.types);
  const minTimestamp = spec.windowMinutes === null ? null : now - spec.windowMinutes * 60_000;
  const sourceEvents =
    spec.types.length === 1
      ? runtime.events.list(sessionId, {
          type: spec.types[0],
        })
      : runtime.events.list(sessionId);
  const matched = sourceEvents.filter((event) => {
    if (typeSet.size > 0 && !typeSet.has(event.type)) {
      return false;
    }
    if (minTimestamp !== null && event.timestamp < minTimestamp) {
      return false;
    }
    return payloadMatchesWhere(event.payload, spec.where);
  });

  const events = spec.last === null ? matched : matched.slice(-spec.last);
  const metricValues = extractMetricValues(events, spec.metric);
  const observedValue =
    spec.metric && spec.aggregation
      ? aggregateMetricValues(
          metricValues.map((entry) => entry.value),
          spec.aggregation,
        )
      : null;

  return {
    events,
    matchCount: events.length,
    sampleSize: metricValues.length,
    observedValue,
  };
}

export function formatMetricValue(value: number | null): string {
  if (value === null) return "none";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export function summarizeEvent(event: BrewvaEventRecord): string {
  const payloadKeys = Object.keys(event.payload ?? {}).slice(0, 6);
  return `${event.type} turn=${event.turn ?? "n/a"} keys=${payloadKeys.join(",") || "none"} ts=${new Date(event.timestamp).toISOString()}`;
}

export function buildRawArtifactText(input: {
  schema: string;
  sessionId: string;
  toolName: string;
  generatedAt: number;
  spec: Record<string, unknown>;
  result: Record<string, unknown>;
  events: BrewvaEventRecord[];
}): string {
  return JSON.stringify(
    {
      schema: input.schema,
      sessionId: input.sessionId,
      toolName: input.toolName,
      generatedAt: input.generatedAt,
      spec: input.spec,
      result: input.result,
      events: input.events,
    },
    null,
    2,
  );
}

export function persistObservabilityArtifact(input: {
  workspaceRoot: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  rawText: string;
  timestamp?: number;
}): ObservabilityArtifactOverride | null {
  if (!input.rawText) return null;

  try {
    const timestamp = Number.isFinite(input.timestamp ?? NaN)
      ? Math.max(0, Math.floor(input.timestamp ?? 0))
      : Date.now();
    const sessionBucket = encodeSessionId(input.sessionId);
    const toolName = sanitizeFileSegment(input.toolName);
    const toolCallId = sanitizeFileSegment(input.toolCallId);
    const artifactDir = resolve(input.workspaceRoot, DEFAULT_ARTIFACT_DIR, sessionBucket);
    const fileName = `${timestamp}-${toolName}-${toolCallId}-raw.json`;
    const absolutePath = resolve(artifactDir, fileName);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(absolutePath, input.rawText, "utf8");

    const rawBytes = Buffer.byteLength(input.rawText, "utf8");
    const rawChars = input.rawText.length;
    const sha256 = createHash("sha256").update(input.rawText).digest("hex");
    const artifactRef = normalizeRelativePath(relative(input.workspaceRoot, absolutePath));

    return {
      artifactRef,
      rawChars,
      rawBytes,
      sha256,
    };
  } catch {
    return null;
  }
}

export function computeObservabilityThrottle(input: {
  events: BrewvaEventRecord[];
  requestedLimit: number;
  now?: number;
}): ObservabilityThrottleState {
  const now = input.now ?? Date.now();
  let recentSingleQueryCalls = 0;

  for (const event of input.events) {
    if (!event) continue;
    if (now - event.timestamp > SEARCH_THROTTLE_WINDOW_MS) continue;
    const payload = event.payload ?? {};
    const previousQueryCount =
      typeof payload.queryCount === "number" && Number.isFinite(payload.queryCount)
        ? Math.max(0, Math.floor(payload.queryCount))
        : 0;
    if (previousQueryCount === 1) {
      recentSingleQueryCalls += 1;
    }
  }

  const projectedSingleQueryCalls = recentSingleQueryCalls + 1;
  if (projectedSingleQueryCalls > SEARCH_THROTTLE_BLOCK_AFTER) {
    return {
      level: "blocked",
      effectiveLimit: 0,
      recentSingleQueryCalls,
    };
  }

  if (projectedSingleQueryCalls > SEARCH_THROTTLE_REDUCE_AFTER) {
    return {
      level: "limited",
      effectiveLimit: Math.min(input.requestedLimit, 1),
      recentSingleQueryCalls,
    };
  }

  return {
    level: "normal",
    effectiveLimit: input.requestedLimit,
    recentSingleQueryCalls,
  };
}

export function getObservabilityThrottleEvents(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  type: string,
): BrewvaEventRecord[] {
  return runtime.events.list(sessionId, {
    type,
    last: SEARCH_THROTTLE_EVENT_LOOKBACK,
  });
}

export function compareObservabilityValue(
  left: number,
  operator: ObservabilityOperator,
  right: number,
): boolean {
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  if (operator === "==") return left === right;
  return left !== right;
}
