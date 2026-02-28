import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.memory.enabled = true;
  config.memory.cognitive.mode = "shadow";
  config.infrastructure.events.level = "ops";
  return config;
}

describe("cognitive relevance ranking event level", () => {
  test("keeps cognitive_relevance_ranking at ops level for shadow evaluation", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cognitive-events-level-")),
      config: createConfig(),
      cognitivePort: {
        rankRelevance: ({ candidates }) =>
          candidates.map((candidate, index) => ({
            id: candidate.id,
            score: index === candidates.length - 1 ? 1 : 0.01,
          })),
      },
    });

    const sessionId = "cognitive-events-level-session";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "database migration from sqlite to postgres with rollback",
    });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "update release notes and changelog formatting",
    });

    const result = await runtime.memory.search(sessionId, {
      query: "database migration",
      limit: 3,
    });
    expect(result.hits.length).toBeGreaterThan(1);

    const rankingEvent = runtime.events.query(sessionId, {
      type: "cognitive_relevance_ranking",
      last: 1,
    })[0];
    expect(rankingEvent).toBeDefined();
  });
});
