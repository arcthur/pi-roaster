export function formatPercent(
  ratio: number | null | undefined,
  options: {
    fallback?: string;
  } = {},
): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    return options.fallback ?? "n/a";
  }
  return `${Math.round(ratio * 1000) / 10}%`;
}

export function normalizeOptionalString(value: unknown): string | null;
export function normalizeOptionalString(
  value: unknown,
  options: {
    emptyValue: undefined;
  },
): string | undefined;
export function normalizeOptionalString(
  value: unknown,
  options: {
    emptyValue: null;
  },
): string | null;
export function normalizeOptionalString(
  value: unknown,
  options: {
    emptyValue?: null | undefined;
  } = {},
): string | null | undefined {
  if (typeof value !== "string") {
    return options.emptyValue ?? null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : (options.emptyValue ?? null);
}

export function extractCompactionSummary(input: unknown): string | undefined {
  const event = input as
    | {
        compactionEntry?: {
          summary?: unknown;
          content?: unknown;
          text?: unknown;
        };
      }
    | undefined;
  const entry = event?.compactionEntry;
  if (!entry) return undefined;

  const candidates = [entry.summary, entry.content, entry.text];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

export function extractCompactionEntryId(input: unknown): string | undefined {
  const event = input as
    | {
        compactionEntry?: {
          id?: unknown;
        };
      }
    | undefined;
  const id = event?.compactionEntry?.id;
  if (typeof id !== "string") return undefined;
  const normalized = id.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveInjectionScopeId(input: unknown): string | undefined {
  const sessionManager = input as
    | { getLeafId?: (() => string | null | undefined) | undefined }
    | undefined;
  const leafId = sessionManager?.getLeafId?.();
  if (typeof leafId !== "string") return undefined;
  const normalized = leafId.trim();
  return normalized.length > 0 ? normalized : undefined;
}
