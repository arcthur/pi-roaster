import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

describe("tape status and search", () => {
  test("recordTapeHandoff writes anchor and resets entriesSinceAnchor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-status-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-status-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "status baseline",
    });
    runtime.task.addItem(sessionId, { text: "before anchor" });

    const before = runtime.events.getTapeStatus(sessionId);
    expect(before.totalEntries).toBeGreaterThan(0);
    expect(before.entriesSinceAnchor).toBe(before.totalEntries);

    const handoff = runtime.events.recordTapeHandoff(sessionId, {
      name: "investigation-done",
      summary: "captured findings",
      nextSteps: "implement changes",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.eventId).toBeDefined();

    const after = runtime.events.getTapeStatus(sessionId);
    expect(after.lastAnchor?.name).toBe("investigation-done");
    expect(after.entriesSinceAnchor).toBe(0);

    runtime.task.addItem(sessionId, { text: "after anchor" });
    const afterMore = runtime.events.getTapeStatus(sessionId);
    expect(afterMore.entriesSinceAnchor).toBe(1);
  });

  test("searchTape scopes current phase by latest anchor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "tape-search-1";

    runtime.events.recordTapeHandoff(sessionId, {
      name: "phase-a",
      summary: "alpha baseline",
      nextSteps: "continue",
    });
    runtime.task.addItem(sessionId, { text: "alpha task" });

    runtime.events.recordTapeHandoff(sessionId, {
      name: "phase-b",
      summary: "beta baseline",
      nextSteps: "continue",
    });
    runtime.task.addItem(sessionId, { text: "beta task" });

    const allPhases = runtime.events.searchTape(sessionId, {
      query: "alpha",
      scope: "all_phases",
    });
    expect(allPhases.matches.length).toBeGreaterThan(0);

    const currentPhase = runtime.events.searchTape(sessionId, {
      query: "alpha",
      scope: "current_phase",
    });
    expect(currentPhase.matches).toHaveLength(0);

    const anchorOnly = runtime.events.searchTape(sessionId, {
      query: "phase-b",
      scope: "anchors_only",
    });
    expect(anchorOnly.matches.length).toBe(1);
    expect(anchorOnly.matches[0]?.type).toBe("anchor");
  });
});
