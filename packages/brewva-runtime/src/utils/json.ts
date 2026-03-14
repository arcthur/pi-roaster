export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : 0;
    case "undefined":
      return null;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.description ?? value.toString();
    case "function":
      return value.name ? `[function ${value.name}]` : "[function]";
    case "object": {
      if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item));
      }
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) continue;
        out[key] = toJsonValue(item);
      }
      return out;
    }
    default:
      return null;
  }
}

export function normalizeJsonRecord(
  payload: Record<string, unknown> | undefined,
): Record<string, JsonValue> | undefined {
  if (!payload) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    out[key] = toJsonValue(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
