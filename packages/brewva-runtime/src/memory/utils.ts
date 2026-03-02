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

export function formatRecallQueryHint(query: string): { hint: string; terms: number } {
  const compact = query.replace(/\s+/g, " ").trim();
  if (!compact) return { hint: "", terms: 0 };
  const terms = compact.split(" ").filter((token) => token.length > 0);
  const hint = terms.slice(0, 12).join(" ");
  const maxChars = 160;
  return {
    hint: hint.length > maxChars ? `${hint.slice(0, maxChars - 3)}...` : hint,
    terms: terms.length,
  };
}
