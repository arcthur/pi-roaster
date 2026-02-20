import type { MemorySourceRef } from "./types.js";

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function sourceRefKey(ref: MemorySourceRef): string {
  return [ref.eventId, ref.eventType, ref.sessionId, ref.evidenceId ?? ""].join("::");
}

export function mergeSourceRefs(
  current: MemorySourceRef[],
  incoming: MemorySourceRef[],
): MemorySourceRef[] {
  const merged = new Map<string, MemorySourceRef>();
  for (const ref of current) {
    merged.set(sourceRefKey(ref), ref);
  }
  for (const ref of incoming) {
    merged.set(sourceRefKey(ref), ref);
  }
  return [...merged.values()].toSorted((left, right) => left.timestamp - right.timestamp);
}
