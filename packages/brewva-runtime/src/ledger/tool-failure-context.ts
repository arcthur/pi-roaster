import type { JsonValue } from "../utils/json.js";

export const TOOL_FAILURE_CONTEXT_METADATA_KEY = "brewvaToolFailureContext";
export const TOOL_FAILURE_CONTEXT_SCHEMA = "brewva.tool_failure_context.v1";

const MAX_PERSISTED_FAILURE_OUTPUT_CHARS = 1800;
const MAX_PERSISTED_FAILURE_ARGS_JSON_CHARS = 1200;
const MAX_PERSISTED_FAILURE_ARG_STRING_CHARS = 280;
const MAX_PERSISTED_FAILURE_ARG_DEPTH = 4;
const MAX_PERSISTED_FAILURE_ARG_KEYS = 40;
const MAX_PERSISTED_FAILURE_ARG_ITEMS = 20;

type JsonRecord = Record<string, JsonValue>;

export interface ToolFailureContextMetadata {
  schema: typeof TOOL_FAILURE_CONTEXT_SCHEMA;
  args: JsonRecord;
  outputText: string;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function normalizeFailureArgs(args: Record<string, unknown>): JsonRecord {
  const seen = new WeakSet<object>();
  const normalized = normalizeUnknownToJson(args, 0, seen);
  const root = isJsonRecord(normalized) ? normalized : { value: normalized };
  const serialized = safeStringify(root);
  if (serialized.length <= MAX_PERSISTED_FAILURE_ARGS_JSON_CHARS) {
    return root;
  }

  return {
    __truncated: true,
    __summary: truncate(serialized, MAX_PERSISTED_FAILURE_ARGS_JSON_CHARS),
  };
}

function normalizeUnknownToJson(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (depth >= MAX_PERSISTED_FAILURE_ARG_DEPTH) {
    return "[max-depth]";
  }

  if (value === null) return null;
  if (value === undefined) return null;

  switch (typeof value) {
    case "string":
      return truncate(value, MAX_PERSISTED_FAILURE_ARG_STRING_CHARS);
    case "number":
      return Number.isFinite(value) ? value : 0;
    case "boolean":
      return value;
    case "bigint":
      return truncate(value.toString(), MAX_PERSISTED_FAILURE_ARG_STRING_CHARS);
    case "symbol":
      return truncate(
        value.description ?? value.toString(),
        MAX_PERSISTED_FAILURE_ARG_STRING_CHARS,
      );
    case "function":
      return value.name ? `[function ${value.name}]` : "[function]";
    case "object":
      if (Array.isArray(value)) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);

        const limitedItems = value
          .slice(0, MAX_PERSISTED_FAILURE_ARG_ITEMS)
          .map((item) => normalizeUnknownToJson(item, depth + 1, seen));
        if (value.length > MAX_PERSISTED_FAILURE_ARG_ITEMS) {
          limitedItems.push(`[truncated_items:${value.length - MAX_PERSISTED_FAILURE_ARG_ITEMS}]`);
        }
        return limitedItems;
      }

      if (!value) return null;
      if (seen.has(value)) return "[circular]";
      seen.add(value);

      const out: JsonRecord = {};
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [key, item] of entries.slice(0, MAX_PERSISTED_FAILURE_ARG_KEYS)) {
        if (item === undefined) continue;
        out[key] = normalizeUnknownToJson(item, depth + 1, seen);
      }
      if (entries.length > MAX_PERSISTED_FAILURE_ARG_KEYS) {
        out.__truncated_keys = entries.length - MAX_PERSISTED_FAILURE_ARG_KEYS;
      }
      return out;
    default:
      return null;
  }
}

function safeStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function withToolFailureContextMetadata(
  metadata: Record<string, unknown> | undefined,
  input: {
    verdict: "pass" | "fail" | "inconclusive";
    args: Record<string, unknown>;
    outputText: string;
  },
): Record<string, unknown> | undefined {
  if (input.verdict !== "fail") return metadata;

  const base = metadata ? { ...metadata } : {};
  base[TOOL_FAILURE_CONTEXT_METADATA_KEY] = {
    schema: TOOL_FAILURE_CONTEXT_SCHEMA,
    args: normalizeFailureArgs(input.args),
    outputText: truncate(input.outputText, MAX_PERSISTED_FAILURE_OUTPUT_CHARS),
  };
  return base;
}

export function readToolFailureContextMetadata(
  metadata: Record<string, JsonValue> | undefined,
): ToolFailureContextMetadata | undefined {
  if (!metadata) return undefined;
  const raw = metadata[TOOL_FAILURE_CONTEXT_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const schema = (raw as { schema?: unknown }).schema;
  if (schema !== TOOL_FAILURE_CONTEXT_SCHEMA) return undefined;

  const args = (raw as { args?: JsonValue }).args;
  const outputText = (raw as { outputText?: unknown }).outputText;
  if (!isJsonRecord(args) || typeof outputText !== "string") return undefined;

  return {
    schema: TOOL_FAILURE_CONTEXT_SCHEMA,
    args,
    outputText,
  };
}
