export function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function truncateText(input: string, maxChars: number): string {
  const limit = normalizePositiveInteger(maxChars, 1);
  if (input.length <= limit) return input;
  if (limit <= 3) return input.slice(0, limit);
  return `${input.slice(0, limit - 3)}...`;
}

export function stripLeadingHeader(text: string, header: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(header)) return trimmed;
  const rest = trimmed.slice(header.length).trim();
  return rest.length > 0 ? rest : trimmed;
}
