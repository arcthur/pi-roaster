import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { MemoryEngine } from "../../packages/brewva-runtime/src/memory/engine.js";
import { ContextMemoryInjectionService } from "../../packages/brewva-runtime/src/services/context-memory-injection.js";
import type {
  BrewvaConfig,
  ContextBudgetUsage,
  SkillDocument,
  TaskState,
} from "../../packages/brewva-runtime/src/types.js";

type CapturedEvent = {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
};

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.memory.enabled = true;
  config.memory.recallMode = "always";
  config.memory.retrievalTopK = 6;
  config.memory.externalRecall.enabled = true;
  config.memory.externalRecall.minInternalScore = 0.8;
  config.memory.externalRecall.queryTopK = 4;
  config.memory.externalRecall.injectedConfidence = 0.6;
  return config;
}

function createTaskState(goal: string): TaskState {
  return {
    spec: {
      schema: "brewva.task.v1",
      goal,
    },
    updatedAt: Date.now(),
    items: [],
    blockers: [],
  };
}

function createExternalSkill(): SkillDocument {
  return {
    name: "external-knowledge-skill",
    description: "mock",
    tier: "project",
    filePath: "skills/external/skill.md",
    baseDir: "skills/external",
    markdown: "mock",
    contract: {
      name: "external-knowledge-skill",
      tier: "project",
      tags: ["external-knowledge"],
      tools: {
        required: [],
        optional: [],
        denied: [],
      },
      budget: {
        maxToolCalls: 20,
        maxTokens: 100_000,
      },
      description: "mock",
    },
  };
}

function createMemoryStub(options?: {
  internalTopScore?: number | null;
  recallBlock?: string;
  counters?: {
    searchCalls: number;
    recallBlockCalls: number;
  };
}): MemoryEngine {
  const internalTopScore = options?.internalTopScore ?? 0.3;
  const recallBlock = options?.recallBlock ?? "previously known detail";
  return {
    refreshIfNeeded: () => {},
    getWorkingMemory: () => ({
      content: "working memory content",
      confidence: 1,
      updatedAt: Date.now(),
    }),
    getOpenInsightTerms: () => ["migration", "rollback"],
    buildRecallBlock: async () => {
      if (options?.counters) {
        options.counters.recallBlockCalls += 1;
      }
      return recallBlock;
    },
    search: async () => {
      if (options?.counters) {
        options.counters.searchCalls += 1;
      }
      return {
        hits:
          internalTopScore === null
            ? []
            : [
                {
                  id: "internal-hit",
                  text: "internal",
                  score: internalTopScore,
                  sourceTier: "session",
                },
              ],
        total: internalTopScore === null ? 0 : 1,
      };
    },
  } as unknown as MemoryEngine;
}

describe("ContextMemoryInjectionService", () => {
  test("returns provider_unavailable decision when external recall is triggered without a provider", async () => {
    const config = createConfig();
    const events: CapturedEvent[] = [];

    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub({ internalTopScore: 0.2 }),
      sanitizeInput: (text) => text,
      getTaskState: () => createTaskState("validate migration rollout"),
      getActiveSkill: () => createExternalSkill(),
      getContextPressureLevel: (_sessionId: string, _usage?: ContextBudgetUsage) => "none",
      registerContextInjection: () => ({ accepted: true }),
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined;
      },
    });

    const outcome = await service.registerMemoryContextInjection(
      "provider-unavailable",
      "find docs",
    );
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "skipped",
        payload: expect.objectContaining({
          reason: "provider_unavailable",
          threshold: 0.8,
        }),
      }),
    );
    expect(events.some((event) => event.type.startsWith("context_external_recall_"))).toBe(false);
  });

  test("returns arena_rejected decision when external block is rejected", async () => {
    const config = createConfig();
    const events: CapturedEvent[] = [];

    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub({ internalTopScore: 0.1 }),
      externalRecallPort: {
        search: async () => [
          {
            topic: "Context compaction policy",
            excerpt: "Trigger compaction when pressure remains critical.",
            score: 0.91,
            confidence: 0.77,
          },
        ],
      },
      sanitizeInput: (text) => text,
      getTaskState: () => createTaskState("validate fallback behavior"),
      getActiveSkill: () => createExternalSkill(),
      getContextPressureLevel: (_sessionId: string, _usage?: ContextBudgetUsage) => "none",
      registerContextInjection: (_sessionId, input) =>
        input.source === "brewva.rag-external"
          ? {
              accepted: false,
              sloEnforced: {
                entriesBefore: 10,
                entriesAfter: 8,
                dropped: true,
              },
            }
          : { accepted: true },
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined;
      },
    });

    const outcome = await service.registerMemoryContextInjection("arena-rejected", "find guidance");
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "skipped",
        payload: expect.objectContaining({
          reason: "arena_rejected",
        }),
      }),
    );
    expect(events.some((event) => event.type.startsWith("context_external_recall_"))).toBe(false);
  });

  test("reuses one internal search result for recall block and external threshold probing", async () => {
    const config = createConfig();
    const counters = {
      searchCalls: 0,
      recallBlockCalls: 0,
    };
    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub({
        internalTopScore: 0.2,
        counters,
      }),
      sanitizeInput: (text) => text,
      getTaskState: () => createTaskState("reuse internal search"),
      getActiveSkill: () => createExternalSkill(),
      getContextPressureLevel: (_sessionId: string, _usage?: ContextBudgetUsage) => "none",
      registerContextInjection: () => ({ accepted: true }),
      recordEvent: () => undefined,
    });

    const outcome = await service.registerMemoryContextInjection("reused-search", "find docs");
    expect(outcome.status).toBe("skipped");
    expect(counters.searchCalls).toBe(1);
    expect(counters.recallBlockCalls).toBe(1);
  });
});
