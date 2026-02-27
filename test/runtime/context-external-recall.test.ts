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
  config.memory.recallMode = "primary";
  config.memory.externalRecall.enabled = true;
  config.memory.externalRecall.minInternalScore = 0.62;
  config.memory.externalRecall.queryTopK = 3;
  config.memory.externalRecall.injectedConfidence = 0.6;
  config.infrastructure.contextBudget.maxInjectionTokens = 4_000;
  config.infrastructure.contextBudget.arena.zones.ragExternal.max = 256;
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
  test("emits skipped event when external recall is triggered but provider is unavailable", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-skip-")),
      config: createConfig(),
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-skip";
    runtime.context.onTurnStart(sessionId, 1);
    await runtime.context.buildInjection(sessionId, "Need external API references");

    const event = runtime.events.query(sessionId, {
      type: "context_external_recall_skipped",
      last: 1,
    })[0];
    expect(event).toBeDefined();
    const payload = event?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("provider_unavailable");
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

    const injectedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_injected",
      last: 1,
    })[0];
    expect(injectedEvent).toBeDefined();

    const searchResult = await runtime.memory.search(sessionId, {
      query: "arena allocator",
      limit: 5,
    });
    expect(searchResult.hits.some((hit) => hit.sourceTier === "external")).toBe(true);
  });

  test("emits filtered_out skip when external recall is accepted into arena but removed by planning", async () => {
    const config = createConfig();
    config.infrastructure.contextBudget.arena.zones.ragExternal.max = 0;
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-filtered-")),
      config,
      externalRecallPort: {
        search: async () => [
          {
            topic: "Arena memory strategy",
            excerpt: "Keep context append-only with explicit epoch reset.",
            score: 0.85,
            confidence: 0.81,
          },
        ],
      },
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-filtered";
    runtime.context.onTurnStart(sessionId, 1);
    const injection = await runtime.context.buildInjection(
      sessionId,
      "Need external memory strategy",
    );
    expect(injection.text.includes("[ExternalRecall]")).toBe(false);

    const injectedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_injected",
      last: 1,
    })[0];
    expect(injectedEvent).toBeUndefined();

    const skippedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_skipped",
      last: 1,
    })[0];
    expect(skippedEvent).toBeDefined();
    const payload = skippedEvent?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("filtered_out");
  });
});
