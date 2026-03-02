import { readIdentityProfile } from "../context/identity.js";
import type {
  ContextInjectionPriority,
  ContextInjectionRegisterResult,
} from "../context/injection.js";
import { CONTEXT_SOURCES } from "../context/sources.js";
import type { ExternalRecallHit, ExternalRecallPort } from "../external-recall/types.js";
import { MemoryEngine } from "../memory/engine.js";
import { formatRecallQueryHint } from "../memory/utils.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextPressureLevel,
  SkillDocument,
  TaskState,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";

export interface ExternalRecallInjectionOutcome {
  query: string;
  hits: ExternalRecallHit[];
  internalTopScore: number | null;
  threshold: number;
}

export type ExternalRecallSkipReason =
  | "pressure_gated"
  | "skill_tag_missing"
  | "internal_score_sufficient"
  | "provider_unavailable"
  | "no_hits"
  | "empty_block"
  | "arena_rejected";

export type ExternalRecallSkipPayload = Record<string, unknown> & {
  reason: ExternalRecallSkipReason;
  query: string;
  threshold?: number;
  internalTopScore?: number | null;
  hitCount?: number;
};

export type ExternalRecallDecision =
  | {
      status: "disabled";
    }
  | {
      status: "skipped";
      payload: ExternalRecallSkipPayload;
    }
  | {
      status: "accepted";
      outcome: ExternalRecallInjectionOutcome;
    };

interface ContextMemoryInjectionServiceOptions {
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  memory: MemoryEngine;
  externalRecallPort?: ExternalRecallPort;
  sanitizeInput: RuntimeCallback<[text: string], string>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
  getContextPressureLevel: RuntimeCallback<
    [sessionId: string, usage?: ContextBudgetUsage],
    ContextPressureLevel
  >;
  registerContextInjection: RuntimeCallback<
    [
      sessionId: string,
      input: {
        source: string;
        id: string;
        content: string;
        priority?: ContextInjectionPriority;
        estimatedTokens?: number;
        oncePerSession?: boolean;
      },
    ],
    ContextInjectionRegisterResult
  >;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

export class ContextMemoryInjectionService {
  private readonly workspaceRoot: string;
  private readonly agentId: string;
  private readonly config: BrewvaConfig;
  private readonly memory: MemoryEngine;
  private readonly externalRecallPort?: ExternalRecallPort;
  private readonly sanitizeInput: ContextMemoryInjectionServiceOptions["sanitizeInput"];
  private readonly getTaskState: ContextMemoryInjectionServiceOptions["getTaskState"];
  private readonly getActiveSkill: ContextMemoryInjectionServiceOptions["getActiveSkill"];
  private readonly getContextPressureLevel: ContextMemoryInjectionServiceOptions["getContextPressureLevel"];
  private readonly registerContextInjection: ContextMemoryInjectionServiceOptions["registerContextInjection"];
  private readonly recordEvent: ContextMemoryInjectionServiceOptions["recordEvent"];

  constructor(options: ContextMemoryInjectionServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.agentId = options.agentId;
    this.config = options.config;
    this.memory = options.memory;
    this.externalRecallPort = options.externalRecallPort;
    this.sanitizeInput = options.sanitizeInput;
    this.getTaskState = options.getTaskState;
    this.getActiveSkill = options.getActiveSkill;
    this.getContextPressureLevel = options.getContextPressureLevel;
    this.registerContextInjection = options.registerContextInjection;
    this.recordEvent = options.recordEvent;
  }

  registerIdentityContextInjection(sessionId: string): void {
    let profile: ReturnType<typeof readIdentityProfile>;
    try {
      profile = readIdentityProfile({
        workspaceRoot: this.workspaceRoot,
        agentId: this.agentId,
      });
    } catch (error) {
      this.recordEvent({
        sessionId,
        type: "identity_parse_warning",
        payload: {
          agentId: this.agentId,
          reason: error instanceof Error ? error.message : "unknown_error",
        },
      });
      return;
    }
    if (!profile) return;

    const content = profile.content.trim();
    if (!content) return;
    this.registerContextInjection(sessionId, {
      source: CONTEXT_SOURCES.identity,
      id: `identity-${profile.agentId}`,
      priority: "critical",
      content,
      oncePerSession: true,
    });
  }

  async registerMemoryContextInjection(
    sessionId: string,
    prompt: string,
    usage?: ContextBudgetUsage,
  ): Promise<ExternalRecallDecision> {
    if (!this.config.memory.enabled) return { status: "disabled" };
    const taskGoal = this.getTaskState(sessionId).spec?.goal;
    this.memory.refreshIfNeeded({ sessionId });

    const working = this.memory.getWorkingMemory(sessionId);
    const workingContent = working?.content.trim() ?? "";
    if (workingContent) {
      this.registerContextInjection(sessionId, {
        source: CONTEXT_SOURCES.memoryWorking,
        id: "memory-working",
        priority: "critical",
        content: workingContent,
      });
    }

    const recallMode = this.config.memory.recallMode ?? "always";
    let shouldIncludeRecall = true;
    let shouldIncludeExternalRecall = true;
    let pressureLevel: ContextPressureLevel | null = null;
    if (recallMode === "pressure-aware") {
      pressureLevel = this.getContextPressureLevel(sessionId, usage);
      if (pressureLevel === "high" || pressureLevel === "critical") {
        shouldIncludeRecall = false;
        shouldIncludeExternalRecall = false;
      }
    }

    const openInsightTerms = this.memory.getOpenInsightTerms(sessionId, 8);
    const recallQuery = [taskGoal, prompt, ...openInsightTerms].filter(Boolean).join("\n");
    if (openInsightTerms.length > 0) {
      this.recordEvent({
        sessionId,
        type: "memory_recall_query_expanded",
        payload: {
          terms: openInsightTerms,
          termsCount: openInsightTerms.length,
        },
      });
    }
    let recallContent = "";
    let internalTopScore: number | null = null;
    const shouldProbeInternalRecall = shouldIncludeRecall || shouldIncludeExternalRecall;
    let recallSearchResult: Awaited<
      ReturnType<ContextMemoryInjectionService["memory"]["search"]>
    > | null = null;
    if (shouldProbeInternalRecall) {
      recallSearchResult = await this.memory.search(sessionId, {
        query: recallQuery,
        limit: shouldIncludeRecall ? this.config.memory.retrievalTopK : 1,
      });
      internalTopScore = recallSearchResult.hits[0]?.score ?? null;
    }

    if (shouldIncludeRecall) {
      const recall = await this.memory.buildRecallBlock({
        sessionId,
        query: recallQuery,
        limit: this.config.memory.retrievalTopK,
        searchResult: recallSearchResult ?? undefined,
      });
      recallContent = recall.trim();
    }

    if (recallContent) {
      this.registerContextInjection(sessionId, {
        source: CONTEXT_SOURCES.memoryRecall,
        id: "memory-recall",
        priority: "normal",
        content: recallContent,
      });
    }

    const externalRecall = await this.decideExternalRecall({
      sessionId,
      query: recallQuery,
      allowed: shouldIncludeExternalRecall,
      pressureLevel,
      internalTopScore,
    });
    return externalRecall;
  }

  private async decideExternalRecall(input: {
    sessionId: string;
    query: string;
    allowed: boolean;
    pressureLevel: ContextPressureLevel | null;
    internalTopScore: number | null;
  }): Promise<ExternalRecallDecision> {
    const externalRecallConfig = this.config.memory.externalRecall;
    if (!externalRecallConfig.enabled) {
      return { status: "disabled" };
    }

    if (!input.allowed) {
      return {
        status: "skipped",
        payload: {
          reason: "pressure_gated",
          query: input.query,
          pressureLevel: input.pressureLevel,
          threshold: externalRecallConfig.minInternalScore,
        },
      };
    }

    const activeSkill = this.getActiveSkill(input.sessionId);
    const isExternalKnowledgeSkill =
      activeSkill?.contract.tags.some((tag) => tag === "external-knowledge") === true;
    if (!isExternalKnowledgeSkill) {
      return {
        status: "skipped",
        payload: {
          reason: "skill_tag_missing",
          query: input.query,
          threshold: externalRecallConfig.minInternalScore,
        },
      };
    }

    if (
      input.internalTopScore !== null &&
      input.internalTopScore >= externalRecallConfig.minInternalScore
    ) {
      return {
        status: "skipped",
        payload: {
          reason: "internal_score_sufficient",
          query: input.query,
          internalTopScore: input.internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      };
    }

    if (!this.externalRecallPort) {
      return {
        status: "skipped",
        payload: {
          reason: "provider_unavailable",
          query: input.query,
          internalTopScore: input.internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      };
    }

    const externalHits = await this.externalRecallPort.search({
      sessionId: input.sessionId,
      query: input.query,
      limit: externalRecallConfig.queryTopK,
    });
    if (externalHits.length === 0) {
      return {
        status: "skipped",
        payload: {
          reason: "no_hits",
          query: input.query,
          internalTopScore: input.internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      };
    }

    const externalBlock = this.buildExternalRecallBlock(input.query, externalHits);
    if (!externalBlock) {
      return {
        status: "skipped",
        payload: {
          reason: "empty_block",
          query: input.query,
          hitCount: externalHits.length,
        },
      };
    }

    const externalRegistration = this.registerContextInjection(input.sessionId, {
      source: CONTEXT_SOURCES.ragExternal,
      id: "rag-external",
      priority: "normal",
      content: externalBlock,
    });
    if (!externalRegistration.accepted) {
      return {
        status: "skipped",
        payload: {
          reason: "arena_rejected",
          query: input.query,
          hitCount: externalHits.length,
          internalTopScore: input.internalTopScore,
          threshold: externalRecallConfig.minInternalScore,
        },
      };
    }

    return {
      status: "accepted",
      outcome: {
        query: input.query,
        hits: externalHits,
        internalTopScore: input.internalTopScore,
        threshold: externalRecallConfig.minInternalScore,
      },
    };
  }

  private buildExternalRecallBlock(query: string, hits: ExternalRecallHit[]): string {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return "";
    const queryHint = formatRecallQueryHint(trimmedQuery);
    const lines: string[] = [
      "[ExternalRecall]",
      `query_hint: ${queryHint.hint}`,
      `query_terms: ${queryHint.terms}`,
    ];
    const normalizedHits = hits
      .map((hit) => ({
        topic: this.sanitizeInput(hit.topic).trim(),
        excerpt: this.sanitizeInput(hit.excerpt).trim(),
        score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : null,
        confidence:
          typeof hit.confidence === "number" && Number.isFinite(hit.confidence)
            ? hit.confidence
            : null,
      }))
      .filter((hit) => hit.topic.length > 0 && hit.excerpt.length > 0)
      .slice(0, 8);
    if (normalizedHits.length === 0) return "";
    normalizedHits.forEach((hit, index) => {
      const score = hit.score !== null ? ` score=${hit.score.toFixed(3)}` : "";
      const confidence = hit.confidence !== null ? ` conf=${hit.confidence.toFixed(3)}` : "";
      lines.push(`${index + 1}. ${hit.topic}${score}${confidence}`);
      lines.push(`   ${hit.excerpt}`);
    });
    return lines.join("\n");
  }
}
