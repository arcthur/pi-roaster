type AnyObject = Record<string, unknown>;

function isObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!isObject(base) || !isObject(patch)) {
    return patch as T;
  }

  const output: AnyObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = output[key];
    if (isObject(current) && isObject(value)) {
      output[key] = deepMerge(current, value);
      continue;
    }
    output[key] = value;
  }
  return output as T;
}
