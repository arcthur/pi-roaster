import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { MemoryEngine } from "../../packages/brewva-runtime/src/memory/engine.js";
import { ContextMemoryInjectionService } from "../../packages/brewva-runtime/src/services/context-memory-injection.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
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
  config.memory.recallMode = "primary";
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
    buildRecallBlock: async () => recallBlock,
    search: async () => ({
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
    }),
  } as unknown as MemoryEngine;
}

describe("ContextMemoryInjectionService", () => {
  test("emits provider_unavailable when external recall is triggered without a provider", async () => {
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
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const outcome = await service.registerMemoryContextInjection(
      "provider-unavailable",
      "find docs",
    );
    expect(outcome).toBeNull();

    const skipped = events.find((event) => event.type === "context_external_recall_skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.payload).toEqual(
      expect.objectContaining({
        reason: "provider_unavailable",
        threshold: 0.8,
      }),
    );
  });

  test("emits arena_rejected with degradation policy when external block is rejected", async () => {
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
                policy: "drop_recall",
                entriesBefore: 10,
                entriesAfter: 8,
                dropped: true,
              },
            }
          : { accepted: true },
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return undefined as BrewvaEventRecord | undefined;
      },
    });

    const outcome = await service.registerMemoryContextInjection("arena-rejected", "find guidance");
    expect(outcome).toBeNull();

    const skipped = events.findLast((event) => event.type === "context_external_recall_skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.payload).toEqual(
      expect.objectContaining({
        reason: "arena_rejected",
        degradationPolicy: "drop_recall",
      }),
    );
  });
});
