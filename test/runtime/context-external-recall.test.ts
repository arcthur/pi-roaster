import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

type RuntimeWithInternals = {
  contextService: {
    getActiveSkill(sessionId: string):
      | {
          name: string;
          contract: { tags: string[] };
        }
      | undefined;
  };
};

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.memory.enabled = true;
  config.memory.recallMode = "always";
  config.memory.externalRecall.enabled = true;
  config.memory.externalRecall.minInternalScore = 0.62;
  config.memory.externalRecall.queryTopK = 3;
  config.memory.externalRecall.injectedConfidence = 0.6;
  config.infrastructure.contextBudget.maxInjectionTokens = 4_000;
  config.infrastructure.toolFailureInjection.enabled = false;
  return config;
}

function patchExternalKnowledgeSkill(runtime: BrewvaRuntime): void {
  const runtimeWithInternals = runtime as unknown as RuntimeWithInternals;
  runtimeWithInternals.contextService.getActiveSkill = () => ({
    name: "external-knowledge-probe",
    contract: {
      tags: ["external-knowledge"],
    },
  });
}

describe("context external recall boundary", () => {
  test("emits provider_unavailable when external recall is triggered without a custom provider", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-skip-")),
      config: createConfig(),
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-skip";
    runtime.context.onTurnStart(sessionId, 1);
    await runtime.context.buildInjection(sessionId, "Need external API references");

    const event = runtime.events.query(sessionId, {
      type: "context_external_recall_decision",
      last: 1,
    })[0];
    expect(event).toBeDefined();
    const payload = event?.payload as { outcome?: string; reason?: string } | undefined;
    expect(payload?.outcome).toBe("skipped");
    expect(payload?.reason).toBe("provider_unavailable");
  });

  test("skips external recall under high pressure when recallMode=pressure-aware", async () => {
    const config = createConfig();
    config.memory.recallMode = "pressure-aware";
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-pressure-gated-")),
      config,
      externalRecallPort: {
        search: async () => [
          {
            topic: "Remote docs",
            excerpt: "This hit should be skipped due to pressure gating.",
            score: 0.93,
            confidence: 0.91,
          },
        ],
      },
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-pressure-gated";
    runtime.context.onTurnStart(sessionId, 1);
    const injection = await runtime.context.buildInjection(
      sessionId,
      "Need external API references",
      { tokens: 950, contextWindow: 1_000, percent: 0.95 },
    );

    expect(injection.text.includes("[ExternalRecall]")).toBe(false);
    const event = runtime.events.query(sessionId, {
      type: "context_external_recall_decision",
      last: 1,
    })[0];
    expect(event).toBeDefined();
    const payload = event?.payload as { outcome?: string; reason?: string } | undefined;
    expect(payload?.outcome).toBe("skipped");
    expect(payload?.reason).toBe("pressure_gated");
  });

  test("injects external recall block and writes back external source-tier memory", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-injected-")),
      config: createConfig(),
      externalRecallPort: {
        search: async () => [
          {
            topic: "Rust arena allocator",
            excerpt: "Arena allocation uses append-only lifecycles with epoch reset.",
            score: 0.91,
            confidence: 0.88,
          },
        ],
      },
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-injected";
    runtime.context.onTurnStart(sessionId, 1);
    const injection = await runtime.context.buildInjection(
      sessionId,
      "Need external API references",
    );

    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[ExternalRecall]")).toBe(true);
    expect(injection.text.includes("query_hint:")).toBe(true);
    expect(injection.text.includes("query_terms:")).toBe(true);
    expect(injection.text.includes("\nquery: ")).toBe(false);

    const injectedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_decision",
      last: 1,
    })[0];
    expect(injectedEvent).toBeDefined();
    const injectedPayload = injectedEvent?.payload as { outcome?: string } | undefined;
    expect(injectedPayload?.outcome).toBe("injected");

    const searchResult = await runtime.memory.search(sessionId, {
      query: "arena allocator",
      limit: 5,
    });
    expect(searchResult.hits.some((hit) => hit.sourceTier === "external")).toBe(true);
  });

  test("expands recall query with open insight topics", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-memory-recall-query-expanded-")),
      config: createConfig(),
    });
    const sessionId = "context-recall-query-expanded";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Ship sqlite migration safely.",
    });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Ship postgres migration safely.",
    });

    runtime.context.onTurnStart(sessionId, 1);
    await runtime.context.buildInjection(sessionId, "review conflicting migration goals");

    const expandedEvent = runtime.events.query(sessionId, {
      type: "memory_recall_query_expanded",
      last: 1,
    })[0];
    expect(expandedEvent).toBeDefined();
    const payload = expandedEvent?.payload as { terms?: string[]; termsCount?: number } | undefined;
    expect(Array.isArray(payload?.terms)).toBe(true);
    expect((payload?.termsCount ?? 0) > 0).toBe(true);
  });

  test("emits skill_tag_missing skip when external recall is enabled without external-knowledge skill", async () => {
    const config = createConfig();
    config.infrastructure.events.level = "debug";
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-skill-tag-missing-")),
      config,
      externalRecallPort: {
        search: async () => [
          {
            topic: "Remote fallback topic",
            excerpt: "Should not be used when skill tag is missing.",
            score: 0.9,
            confidence: 0.9,
          },
        ],
      },
    });

    const sessionId = "context-external-recall-skill-tag-missing";
    runtime.context.onTurnStart(sessionId, 1);
    await runtime.context.buildInjection(sessionId, "Need external references");

    const skippedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_decision_debug",
      last: 1,
    })[0];
    expect(skippedEvent).toBeDefined();
    const payload = skippedEvent?.payload as { outcome?: string; reason?: string } | undefined;
    expect(payload?.outcome).toBe("skipped");
    expect(payload?.reason).toBe("skill_tag_missing");
  });

  test("emits internal_score_sufficient skip when internal recall score exceeds threshold", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-score-sufficient-")),
      config: createConfig(),
      externalRecallPort: {
        search: async () => [
          {
            topic: "Remote fallback topic",
            excerpt: "Should not be used when internal score is sufficient.",
            score: 0.9,
            confidence: 0.9,
          },
        ],
      },
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-score-sufficient";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Need external references for api docs",
    });
    runtime.context.onTurnStart(sessionId, 1);
    await runtime.context.buildInjection(sessionId, "Need external references for api docs");

    const skippedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_decision",
      last: 1,
    })[0];
    expect(skippedEvent).toBeDefined();
    const payload = skippedEvent?.payload as
      | { outcome?: string; reason?: string; internalTopScore?: number }
      | undefined;
    expect(payload?.outcome).toBe("skipped");
    expect(payload?.reason).toBe("internal_score_sufficient");
    expect((payload?.internalTopScore ?? 0) >= 0.62).toBe(true);
  });

  test("emits provider_unavailable when external recall is enabled without a custom port", async () => {
    const config = createConfig();
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-provider-unavailable-")),
      config,
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-provider-unavailable";
    runtime.context.onTurnStart(sessionId, 1);
    const injection = await runtime.context.buildInjection(sessionId, "Need external references");

    expect(injection.text.includes("[ExternalRecall]")).toBe(false);
    const skippedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_decision",
      last: 1,
    })[0];
    expect(skippedEvent).toBeDefined();
    const payload = skippedEvent?.payload as { outcome?: string; reason?: string } | undefined;
    expect(payload?.outcome).toBe("skipped");
    expect(payload?.reason).toBe("provider_unavailable");
  });
});
