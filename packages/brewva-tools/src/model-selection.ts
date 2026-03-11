import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type BrewvaThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

interface ModelMatchResult {
  model?: RegisteredModel;
  ambiguous?: RegisteredModel[];
}

function isValidThinkingLevel(value: string): value is BrewvaThinkingLevel {
  return VALID_THINKING_LEVELS.includes(value as BrewvaThinkingLevel);
}

function toModelKey(model: RegisteredModel): string {
  return `${model.provider}/${model.id}`;
}

function dedupeMatches(matches: RegisteredModel[]): RegisteredModel[] {
  const unique = new Map<string, RegisteredModel>();
  for (const model of matches) {
    unique.set(toModelKey(model).toLowerCase(), model);
  }
  return [...unique.values()];
}

function collectMatches(
  pattern: string,
  availableModels: RegisteredModel[],
  predicate: (candidate: string, normalizedPattern: string) => boolean,
): RegisteredModel[] {
  const normalizedPattern = pattern.toLowerCase();
  return dedupeMatches(
    availableModels.filter((model) => {
      const candidates = [model.id, `${model.provider}/${model.id}`, model.name ?? ""];
      return candidates.some((candidate) => predicate(candidate.toLowerCase(), normalizedPattern));
    }),
  );
}

function toMatchResult(matches: RegisteredModel[]): ModelMatchResult {
  if (matches.length === 1) {
    return { model: matches[0] };
  }
  if (matches.length > 1) {
    return {
      ambiguous: matches.toSorted((left, right) =>
        toModelKey(left).localeCompare(toModelKey(right)),
      ),
    };
  }
  return {};
}

function findModelMatch(pattern: string, availableModels: RegisteredModel[]): ModelMatchResult {
  const exact = collectMatches(
    pattern,
    availableModels,
    (candidate, normalizedPattern) => candidate === normalizedPattern,
  );
  if (exact.length > 0) {
    return toMatchResult(exact);
  }

  const prefix = collectMatches(pattern, availableModels, (candidate, normalizedPattern) =>
    candidate.startsWith(normalizedPattern),
  );
  if (prefix.length > 0) {
    return toMatchResult(prefix);
  }

  const substring = collectMatches(pattern, availableModels, (candidate, normalizedPattern) =>
    candidate.includes(normalizedPattern),
  );
  return toMatchResult(substring);
}

function parseModelPattern(
  pattern: string,
  availableModels: RegisteredModel[],
): ModelMatchResult & { thinkingLevel?: BrewvaThinkingLevel } {
  const directMatch = findModelMatch(pattern, availableModels);
  if (directMatch.model || directMatch.ambiguous) {
    return directMatch;
  }

  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return { model: undefined };
  }

  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  if (!isValidThinkingLevel(suffix)) {
    return { model: undefined };
  }

  const resolved = parseModelPattern(prefix, availableModels);
  if (!resolved.model || resolved.ambiguous) {
    return resolved;
  }
  return {
    model: resolved.model,
    thinkingLevel: suffix,
  };
}

function findExactModel(
  pattern: string,
  availableModels: RegisteredModel[],
): RegisteredModel | undefined {
  const lowered = pattern.toLowerCase();
  return availableModels.find(
    (model) =>
      model.id.toLowerCase() === lowered ||
      `${model.provider}/${model.id}`.toLowerCase() === lowered,
  );
}

export interface BrewvaModelSelection {
  model?: RegisteredModel;
  thinkingLevel?: BrewvaThinkingLevel;
}

function formatAmbiguousModelError(pattern: string, matches: RegisteredModel[]): Error {
  const candidates = matches.map((model) => toModelKey(model)).join(", ");
  return new Error(`Model "${pattern}" is ambiguous. Candidates: ${candidates}`);
}

export function resolveBrewvaModelSelection(
  modelText: string | undefined,
  registry: ModelRegistry,
): BrewvaModelSelection {
  const normalized = modelText?.trim();
  if (!normalized) {
    return {};
  }

  const availableModels = registry.getAll();
  if (availableModels.length === 0) {
    throw new Error("No models are available in the Brewva model registry.");
  }

  const providerMap = new Map<string, string>();
  for (const model of availableModels) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }

  let provider: string | undefined;
  let pattern = normalized;
  let inferredProvider = false;

  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) {
    const maybeProvider = normalized.substring(0, slashIndex);
    const canonicalProvider = providerMap.get(maybeProvider.toLowerCase());
    if (canonicalProvider) {
      provider = canonicalProvider;
      pattern = normalized.substring(slashIndex + 1);
      inferredProvider = true;
    }
  }

  if (!provider) {
    const exact = findExactModel(normalized, availableModels);
    if (exact) {
      return { model: exact };
    }
  }

  const candidates = provider
    ? availableModels.filter((model) => model.provider === provider)
    : availableModels;
  const resolved = parseModelPattern(pattern, candidates);
  if (resolved.ambiguous) {
    throw formatAmbiguousModelError(
      provider ? `${provider}/${pattern}` : pattern,
      resolved.ambiguous,
    );
  }
  if (resolved.model) {
    return resolved;
  }

  if (inferredProvider) {
    const exact = findExactModel(normalized, availableModels);
    if (exact) {
      return { model: exact };
    }

    const fallback = parseModelPattern(normalized, availableModels);
    if (fallback.ambiguous) {
      throw formatAmbiguousModelError(normalized, fallback.ambiguous);
    }
    if (fallback.model) {
      return fallback;
    }
  }

  const display = provider ? `${provider}/${pattern}` : normalized;
  throw new Error(`Model "${display}" was not found in the configured Brewva model registry.`);
}
