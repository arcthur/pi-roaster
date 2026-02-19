import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";

const ENTRY_SEPARATOR = "\n\n";

export type ContextInjectionPriority = "critical" | "high" | "normal" | "low";
export type ContextInjectionTruncationStrategy = "drop-entry" | "summarize" | "tail";

export interface RegisterContextInjectionInput {
  source: string;
  id: string;
  content: string;
  priority?: ContextInjectionPriority;
  estimatedTokens?: number;
  oncePerSession?: boolean;
}

export interface ContextInjectionEntry {
  source: string;
  id: string;
  content: string;
  priority: ContextInjectionPriority;
  estimatedTokens: number;
  timestamp: number;
  oncePerSession: boolean;
  truncated: boolean;
}

export interface ContextInjectionConsumeResult {
  text: string;
  entries: ContextInjectionEntry[];
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextInjectionPlanResult extends ContextInjectionConsumeResult {
  consumedKeys: string[];
}

const PRIORITY_ORDER: Record<ContextInjectionPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class ContextInjectionCollector {
  private readonly sourceTokenLimits: Record<string, number>;
  private readonly truncationStrategy: ContextInjectionTruncationStrategy;
  private readonly entriesBySession = new Map<string, Map<string, ContextInjectionEntry>>();
  private readonly onceKeysBySession = new Map<string, Set<string>>();

  constructor(options: { sourceTokenLimits?: Record<string, number>; truncationStrategy?: ContextInjectionTruncationStrategy } = {}) {
    this.sourceTokenLimits = { ...(options.sourceTokenLimits ?? {}) };
    this.truncationStrategy = options.truncationStrategy ?? "summarize";
  }

  register(sessionId: string, input: RegisterContextInjectionInput): void {
    const source = input.source.trim();
    const id = input.id.trim();
    if (!sessionId || !source || !id) return;

    const content = input.content.trim();
    if (!content) return;

    const oncePerSession = input.oncePerSession === true;
    const key = `${source}:${id}`;
    if (oncePerSession) {
      const onceKeys = this.getOrCreateOnceKeys(sessionId);
      if (onceKeys.has(key)) {
        return;
      }
    }

    const priority = input.priority ?? "normal";
    let entry: ContextInjectionEntry = {
      source,
      id,
      content,
      priority,
      estimatedTokens: estimateTokenCount(content),
      timestamp: Date.now(),
      oncePerSession,
      truncated: false,
    };

    const sourceLimit = this.resolveSourceLimit(source);
    if (Number.isFinite(sourceLimit) && entry.estimatedTokens > sourceLimit) {
      const fitted = this.fitEntryToBudget(entry, sourceLimit);
      if (!fitted) return;
      entry = fitted;
    }

    if (entry.estimatedTokens <= 0) return;

    const sessionEntries = this.getOrCreateEntries(sessionId);
    sessionEntries.set(key, entry);
  }

  plan(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult {
    const sessionEntries = this.entriesBySession.get(sessionId);
    if (!sessionEntries || sessionEntries.size === 0) {
      return { text: "", entries: [], estimatedTokens: 0, truncated: false, consumedKeys: [] };
    }

    const sorted = [...sessionEntries.entries()]
      .sort((left, right) => {
        const leftEntry = left[1];
        const rightEntry = right[1];
        const byPriority = PRIORITY_ORDER[leftEntry.priority] - PRIORITY_ORDER[rightEntry.priority];
        if (byPriority !== 0) return byPriority;
        return leftEntry.timestamp - rightEntry.timestamp;
      });

    const consumedKeys: string[] = [];
    const accepted: ContextInjectionEntry[] = [];
    const separatorTokens = estimateTokenCount(ENTRY_SEPARATOR);
    let remainingTokens = Math.max(0, Math.floor(totalTokenBudget));
    let truncated = false;

    for (const [key, entry] of sorted) {
      const separatorCost = accepted.length > 0 ? separatorTokens : 0;
      if (remainingTokens <= separatorCost) {
        truncated = true;
        break;
      }

      const entryBudget = Math.max(0, remainingTokens - separatorCost);
      if (entry.estimatedTokens <= entryBudget) {
        consumedKeys.push(key);
        accepted.push(entry);
        remainingTokens = Math.max(0, remainingTokens - separatorCost - entry.estimatedTokens);
        continue;
      }

      const fitted = this.fitEntryToBudget(entry, entryBudget);
      truncated = true;
      if (fitted) {
        consumedKeys.push(key);
        accepted.push(fitted);
        remainingTokens = Math.max(0, remainingTokens - separatorCost - fitted.estimatedTokens);

        if (this.truncationStrategy === "tail") {
          break;
        }
        continue;
      }

      if (this.truncationStrategy === "drop-entry" || this.truncationStrategy === "summarize") {
        continue;
      }

      break;
    }

    const text = accepted.map((entry) => entry.content).join(ENTRY_SEPARATOR);
    const estimatedTokens = estimateTokenCount(text);
    return {
      text,
      entries: accepted,
      estimatedTokens,
      truncated,
      consumedKeys,
    };
  }

  commit(sessionId: string, consumedKeys: string[]): void {
    if (consumedKeys.length === 0) return;
    const sessionEntries = this.entriesBySession.get(sessionId);
    if (!sessionEntries) return;

    const onceKeys = this.getOrCreateOnceKeys(sessionId);
    for (const key of consumedKeys) {
      const entry = sessionEntries.get(key);
      if (entry?.oncePerSession) {
        onceKeys.add(key);
      }
      sessionEntries.delete(key);
    }
    if (sessionEntries.size === 0) {
      this.entriesBySession.delete(sessionId);
    }
  }

  consume(sessionId: string, totalTokenBudget: number): ContextInjectionConsumeResult {
    const plan = this.plan(sessionId, totalTokenBudget);
    this.commit(sessionId, plan.consumedKeys);
    return {
      text: plan.text,
      entries: plan.entries,
      estimatedTokens: plan.estimatedTokens,
      truncated: plan.truncated,
    };
  }

  clearPending(sessionId: string): void {
    this.entriesBySession.delete(sessionId);
  }

  resetOncePerSession(sessionId: string): void {
    this.onceKeysBySession.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.entriesBySession.delete(sessionId);
    this.onceKeysBySession.delete(sessionId);
  }

  private fitEntryToBudget(entry: ContextInjectionEntry, tokenBudget: number): ContextInjectionEntry | null {
    const budget = Math.max(0, Math.floor(tokenBudget));
    if (budget <= 0) return null;
    if (entry.estimatedTokens <= budget) return entry;

    if (this.truncationStrategy === "drop-entry") {
      return null;
    }

    if (this.truncationStrategy === "summarize") {
      const summary = truncateTextToTokenBudget(this.buildTruncatedSummary(entry), budget);
      const summaryTokens = estimateTokenCount(summary);
      if (summaryTokens <= 0) return null;
      return {
        ...entry,
        content: summary,
        estimatedTokens: summaryTokens,
        truncated: true,
      };
    }

    const partialText = truncateTextToTokenBudget(entry.content, budget);
    const partialTokens = estimateTokenCount(partialText);
    if (partialTokens <= 0) return null;
    return {
      ...entry,
      content: partialText,
      estimatedTokens: partialTokens,
      truncated: true,
    };
  }

  private buildTruncatedSummary(entry: ContextInjectionEntry): string {
    return [
      "[ContextTruncated]",
      `source=${entry.source}`,
      `id=${entry.id}`,
      `originalTokens=${entry.estimatedTokens}`,
      "reason=budget_limit",
    ].join("\n");
  }

  private resolveSourceLimit(source: string): number {
    const configured = this.sourceTokenLimits[source];
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, Math.floor(configured));
  }

  private getOrCreateEntries(sessionId: string): Map<string, ContextInjectionEntry> {
    const existing = this.entriesBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, ContextInjectionEntry>();
    this.entriesBySession.set(sessionId, created);
    return created;
  }

  private getOrCreateOnceKeys(sessionId: string): Set<string> {
    const existing = this.onceKeysBySession.get(sessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.onceKeysBySession.set(sessionId, created);
    return created;
  }
}
