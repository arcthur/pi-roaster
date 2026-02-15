import { describe, expect, test } from "bun:test";
import { ContextInjectionCollector } from "@pi-roaster/roaster-runtime";

describe("Context injection collector", () => {
  const estimateTokens = (text: string): number => Math.max(0, Math.ceil(text.length / 3.5));

  test("does not let oversized provided estimates drop later entries", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-oversized-estimate";

    collector.register(sessionId, {
      source: "source-a",
      id: "a",
      priority: "high",
      content: "first",
      estimatedTokens: 1000,
    });
    collector.register(sessionId, {
      source: "source-b",
      id: "b",
      priority: "normal",
      content: "second",
      estimatedTokens: 2,
    });

    const merged = collector.consume(sessionId, 16);

    expect(merged.entries).toHaveLength(2);
    expect(merged.text.includes("first")).toBe(true);
    expect(merged.text.includes("second")).toBe(true);
  });

  test("does not consume once-per-session entry before commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-once-before-commit";

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      priority: "high",
      content: "first pass",
      oncePerSession: true,
    });

    const planned = collector.plan(sessionId, 128);
    expect(planned.entries).toHaveLength(1);
    collector.clearPending(sessionId);

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      priority: "high",
      content: "second pass",
      oncePerSession: true,
    });
    const consumed = collector.consume(sessionId, 128);

    expect(consumed.entries).toHaveLength(1);
    expect(consumed.text.includes("second pass")).toBe(true);
  });

  test("blocks once-per-session entry after commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-once-after-commit";

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      priority: "high",
      content: "only once",
      oncePerSession: true,
    });
    const first = collector.consume(sessionId, 128);
    expect(first.entries).toHaveLength(1);

    collector.register(sessionId, {
      source: "source-once",
      id: "once-id",
      priority: "high",
      content: "should be skipped",
      oncePerSession: true,
    });
    const second = collector.consume(sessionId, 128);
    expect(second.entries).toHaveLength(0);
  });

  test("uses conservative token estimate for dense text", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "collector-conservative-estimate";
    const dense = "x".repeat(15);

    collector.register(sessionId, {
      source: "source-dense",
      id: "dense",
      priority: "normal",
      content: dense,
    });

    const consumed = collector.consume(sessionId, 128);
    expect(consumed.entries).toHaveLength(1);
    expect(consumed.entries[0]?.estimatedTokens).toBe(5);
  });

  test("summarize strategy avoids tail-cutting structured content", () => {
    const collector = new ContextInjectionCollector({ truncationStrategy: "summarize" });
    const sessionId = "collector-summarize-strategy";
    const structured = JSON.stringify({
      skills: ["debugging", "patching", "review"],
      objective: "Fix flaky test and preserve context format",
      notes: "x".repeat(200),
    });

    collector.register(sessionId, {
      source: "source-structured",
      id: "structured",
      priority: "high",
      content: structured,
    });

    const consumed = collector.consume(sessionId, 10);
    expect(consumed.entries).toHaveLength(1);
    expect(consumed.entries[0]?.content.includes("[ContextTruncated]")).toBe(true);
    expect(consumed.entries[0]?.content.includes("{\"skills\"")).toBe(false);
  });

  test("drop-entry strategy skips oversized entries and keeps smaller ones", () => {
    const collector = new ContextInjectionCollector({ truncationStrategy: "drop-entry" });
    const sessionId = "collector-drop-entry-strategy";

    collector.register(sessionId, {
      source: "source-large",
      id: "large",
      priority: "high",
      content: "x".repeat(200),
    });
    collector.register(sessionId, {
      source: "source-small",
      id: "small",
      priority: "normal",
      content: "small-context",
    });

    const first = collector.consume(sessionId, 8);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]?.id).toBe("small");

    const second = collector.consume(sessionId, 80);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.id).toBe("large");
  });

  test("accounts for entry separators when planning token budget", () => {
    const collector = new ContextInjectionCollector({ truncationStrategy: "tail" });
    const sessionId = "collector-separator-budget";
    const block = "x".repeat(35);

    collector.register(sessionId, {
      source: "source-a",
      id: "a",
      priority: "high",
      content: block,
    });
    collector.register(sessionId, {
      source: "source-b",
      id: "b",
      priority: "normal",
      content: block,
    });

    const planned = collector.plan(sessionId, 20);
    expect(planned.entries.length).toBeGreaterThan(0);
    expect(estimateTokens(planned.text)).toBeLessThanOrEqual(20);
  });
});
