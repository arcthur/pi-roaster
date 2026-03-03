import { describe, expect, test } from "bun:test";
import { ContextInjectionCollector } from "@brewva/brewva-runtime";

describe("ContextInjectionCollector characterization", () => {
  test("plans entries by priority order", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-priority";

    collector.register(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      priority: "normal",
      content: "memory content",
    });
    collector.register(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      priority: "critical",
      content: "truth content",
    });

    const planned = collector.plan(sessionId, 10_000);
    expect(planned.entries).toHaveLength(2);
    expect(planned.entries[0]?.source).toBe("brewva.truth-facts");
    expect(planned.entries[1]?.source).toBe("brewva.memory-working");
  });

  test("commit removes consumed entries from next plan", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-commit";

    collector.register(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-facts",
      priority: "critical",
      content: "fact A",
    });
    const planned = collector.plan(sessionId, 10_000);
    collector.commit(sessionId, planned.consumedKeys);

    const second = collector.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
    expect(second.text).toBe("");
  });

  test("oncePerSession blocks re-registration after commit", () => {
    const collector = new ContextInjectionCollector();
    const sessionId = "ctx-char-once";

    collector.register(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      priority: "critical",
      content: "identity",
      oncePerSession: true,
    });
    const first = collector.plan(sessionId, 10_000);
    collector.commit(sessionId, first.consumedKeys);

    collector.register(sessionId, {
      source: "brewva.identity",
      id: "identity-1",
      priority: "critical",
      content: "identity v2",
      oncePerSession: true,
    });
    const second = collector.plan(sessionId, 10_000);
    expect(second.entries).toHaveLength(0);
  });

  test("drop-entry truncation strategy drops oversized entries", () => {
    const collector = new ContextInjectionCollector({
      truncationStrategy: "drop-entry",
    });
    const sessionId = "ctx-char-drop-entry";

    collector.register(sessionId, {
      source: "brewva.truth-facts",
      id: "big",
      priority: "critical",
      content: "x".repeat(50_000),
    });

    const plan = collector.plan(sessionId, 10);
    expect(plan.entries).toHaveLength(0);
    expect(plan.truncated).toBe(true);
  });

  test("tail truncation stops planning after first truncated oversized entry", () => {
    const collector = new ContextInjectionCollector({
      truncationStrategy: "tail",
    });
    const sessionId = "ctx-char-tail";

    collector.register(sessionId, {
      source: "source-a",
      id: "a",
      priority: "critical",
      content: "short",
    });
    collector.register(sessionId, {
      source: "source-b",
      id: "b",
      priority: "normal",
      content: "x".repeat(50_000),
    });
    collector.register(sessionId, {
      source: "source-c",
      id: "c",
      priority: "low",
      content: "another short",
    });

    const plan = collector.plan(sessionId, 30);
    const sources = plan.entries.map((entry) => entry.source);
    expect(sources).not.toContain("source-c");
  });

  test("sourceTokenLimits truncates individual source entries under tail strategy", () => {
    const collector = new ContextInjectionCollector({
      truncationStrategy: "tail",
      sourceTokenLimits: {
        "brewva.memory-working": 5,
      },
    });
    const sessionId = "ctx-char-source-limit";

    collector.register(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      priority: "normal",
      content: "x".repeat(5_000),
    });
    const plan = collector.plan(sessionId, 10_000);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.truncated).toBe(true);
    expect((plan.entries[0]?.estimatedTokens ?? 0) <= 5).toBe(true);
  });

  test("sourceTokenLimits rejects oversized entries under drop-low-fidelity strategy", () => {
    const collector = new ContextInjectionCollector({
      truncationStrategy: "drop-low-fidelity",
      sourceTokenLimits: {
        "brewva.memory-working": 5,
      },
    });
    const sessionId = "ctx-char-source-limit-drop-low-fidelity";

    const register = collector.register(sessionId, {
      source: "brewva.memory-working",
      id: "memory-working",
      priority: "normal",
      content: "x".repeat(5_000),
    });

    const plan = collector.plan(sessionId, 10_000);
    expect(register.accepted).toBe(false);
    expect(plan.entries).toHaveLength(0);
    expect(plan.text).toBe("");
  });
});
