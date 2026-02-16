export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return String(value);
}

export function normalizeJsonRecord(payload: Record<string, unknown> | undefined): Record<string, JsonValue> | undefined {
  if (!payload) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    out[key] = toJsonValue(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
