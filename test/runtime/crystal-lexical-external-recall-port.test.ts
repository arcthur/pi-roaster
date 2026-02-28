import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrystalLexicalExternalRecallPort } from "@brewva/brewva-runtime";

interface ProjectionRow {
  id: string;
  sessionId: string;
  topic: string;
  summary: string;
  confidence?: number;
  updatedAt?: number;
}

function writeJsonl(path: string, rows: ProjectionRow[], extraLines: string[] = []): void {
  const lines = [...rows.map((row) => JSON.stringify(row)), ...extraLines];
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}

describe("crystal lexical external recall port", () => {
  test("returns ranked hits, includes global crystals, and excludes same-session candidates", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-crystal-lexical-port-"));
    const memoryRoot = join(workspace, ".orchestrator", "memory");
    mkdirSync(memoryRoot, { recursive: true });
    mkdirSync(join(memoryRoot, "global"), { recursive: true });

    writeJsonl(join(memoryRoot, "crystals.jsonl"), [
      {
        id: "local-current",
        sessionId: "session-current",
        topic: "Current session private note",
        summary: "Should never leak into external recall for the same session.",
        confidence: 0.91,
        updatedAt: 10,
      },
      {
        id: "local-postgres",
        sessionId: "session-alpha",
        topic: "Postgres lock timeout mitigation",
        summary: "Use lock timeout guards and phased migration retries.",
        confidence: 0.84,
        updatedAt: 20,
      },
      {
        id: "local-redis",
        sessionId: "session-beta",
        topic: "Redis cache warmup plan",
        summary: "Prime hot keys after deploy.",
        confidence: 0.73,
        updatedAt: 15,
      },
    ]);
    writeJsonl(join(memoryRoot, "global", "crystals.jsonl"), [
      {
        id: "global-postgres",
        sessionId: "session-global",
        topic: "Postgres migration safety checklist",
        summary: "Shadow write, verify counts, then flip reads.",
        confidence: 0.88,
        updatedAt: 30,
      },
    ]);

    const port = createCrystalLexicalExternalRecallPort({
      memoryRootDir: memoryRoot,
      includeWorkspaceCrystals: true,
      includeGlobalCrystals: true,
      minSimilarity: 0.01,
    });
    const hits = await port.search({
      sessionId: "session-current",
      query: "postgres migration lock timeout",
      limit: 3,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.topic.toLowerCase().includes("checklist"))).toBe(true);
    expect(
      hits.every(
        (hit) =>
          ((hit.metadata as { crystalSessionId?: string } | undefined)?.crystalSessionId ??
            "session-current") !== "session-current",
      ),
    ).toBe(true);
    expect(hits[0]?.topic.toLowerCase().includes("postgres")).toBe(true);
    for (let index = 1; index < hits.length; index += 1) {
      expect((hits[index - 1]?.score ?? 0) >= (hits[index]?.score ?? 0)).toBe(true);
    }
  });

  test("skips malformed json lines and handles empty query", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-crystal-lexical-port-malformed-"));
    const memoryRoot = join(workspace, ".orchestrator", "memory");
    mkdirSync(memoryRoot, { recursive: true });

    writeJsonl(
      join(memoryRoot, "crystals.jsonl"),
      [
        {
          id: "local-arena",
          sessionId: "session-zeta",
          topic: "Arena allocator design",
          summary: "Append-only chunks with epoch reset and cheap recycling.",
          confidence: 0.82,
          updatedAt: 42,
        },
      ],
      ["{malformed-json-line"],
    );

    const port = createCrystalLexicalExternalRecallPort({
      memoryRootDir: memoryRoot,
      includeWorkspaceCrystals: true,
      minSimilarity: 0.01,
    });

    const emptyQueryHits = await port.search({
      sessionId: "session-current",
      query: "   ",
      limit: 5,
    });
    expect(emptyQueryHits).toEqual([]);

    const hits = await port.search({
      sessionId: "session-current",
      query: "arena allocator chunks",
      limit: 5,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.topic).toBe("Arena allocator design");
  });
});
