import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function seedCrystalProjection(
  workspace: string,
  config: BrewvaConfig,
  rows: Array<{
    id: string;
    sessionId: string;
    topic: string;
    summary: string;
    confidence: number;
    updatedAt: number;
  }>,
  scope: "workspace" | "global" = "workspace",
): void {
  const memoryRoot = join(workspace, config.memory.dir);
  const targetRoot = scope === "global" ? join(memoryRoot, "global") : memoryRoot;
  mkdirSync(targetRoot, { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(join(targetRoot, "crystals.jsonl"), content ? `${content}\n` : "", "utf8");
}

describe("context external recall boundary", () => {
  test("emits no_hits skip when external recall is triggered but projection has no retrievable crystals", async () => {
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
    expect(payload?.reason).toBe("no_hits");
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

    const searchResult = await runtime.memory.search(sessionId, {
      query: "Arena memory strategy",
      limit: 5,
    });
    expect(searchResult.hits.some((hit) => hit.sourceTier === "external")).toBe(false);
  });

  test("uses built-in crystal lexical external recall port when no provider is injected", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-external-recall-default-port-"));
    const config = createConfig();
    config.memory.global.enabled = false;
    seedCrystalProjection(workspace, config, [
      {
        id: "crystal-workspace",
        sessionId: "workspace-session",
        topic: "Workspace-only crystal (should not be used by default provider)",
        summary: "HNSW supports fast ANN retrieval for embedding similarity search.",
        confidence: 0.95,
        updatedAt: Date.now() - 10_000,
      },
    ]);
    seedCrystalProjection(
      workspace,
      config,
      [
        {
          id: "crystal-global",
          sessionId: "__global__",
          topic: "Approximate nearest neighbor index",
          summary: "HNSW supports fast ANN retrieval for embedding similarity search.",
          confidence: 0.78,
          updatedAt: Date.now(),
        },
      ],
      "global",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config,
    });
    patchExternalKnowledgeSkill(runtime);

    const sessionId = "context-external-recall-default-port";
    runtime.context.onTurnStart(sessionId, 1);
    const injection = await runtime.context.buildInjection(
      sessionId,
      "Need external guidance for HNSW nearest neighbor retrieval",
    );

    expect(injection.text.includes("[ExternalRecall]")).toBe(true);
    expect(
      injection.text.includes("Workspace-only crystal (should not be used by default provider)"),
    ).toBe(false);
    const injectedEvent = runtime.events.query(sessionId, {
      type: "context_external_recall_injected",
      last: 1,
    })[0];
    expect(injectedEvent).toBeDefined();
    const payload = injectedEvent?.payload as { hitCount?: number } | undefined;
    expect((payload?.hitCount ?? 0) > 0).toBe(true);
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
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-external-recall-skill-tag-missing-")),
      config: createConfig(),
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
      type: "context_external_recall_skipped",
      last: 1,
    })[0];
    expect(skippedEvent).toBeDefined();
    const payload = skippedEvent?.payload as { reason?: string } | undefined;
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
      type: "context_external_recall_skipped",
      last: 1,
    })[0];
    expect(skippedEvent).toBeDefined();
    const payload = skippedEvent?.payload as
      | { reason?: string; internalTopScore?: number }
      | undefined;
    expect(payload?.reason).toBe("internal_score_sufficient");
    expect((payload?.internalTopScore ?? 0) >= 0.62).toBe(true);
  });
});
