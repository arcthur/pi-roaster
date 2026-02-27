import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createConfig(): BrewvaConfig {
  return structuredClone(DEFAULT_BREWVA_CONFIG);
}

describe("context compaction request dedupe", () => {
  test("does not emit duplicate context_compaction_requested for the same pending reason", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-compaction-request-")),
      config: createConfig(),
    });
    const sessionId = "context-compaction-request-dedupe";

    runtime.context.requestCompaction(sessionId, "usage_threshold");
    runtime.context.requestCompaction(sessionId, "usage_threshold");
    runtime.context.requestCompaction(sessionId, "hard_limit");

    const events = runtime.events.query(sessionId, {
      type: "context_compaction_requested",
    });
    const reasons = events.map(
      (event) => (event.payload as { reason?: string } | undefined)?.reason,
    );
    expect(reasons).toEqual(["usage_threshold", "hard_limit"]);
  });
});
