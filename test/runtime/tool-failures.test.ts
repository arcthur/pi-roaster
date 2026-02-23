import { describe, expect, test } from "bun:test";
import { buildRecentToolFailuresBlock } from "@brewva/brewva-runtime";

describe("buildRecentToolFailuresBlock", () => {
  test("returns empty string when no failures", () => {
    const result = buildRecentToolFailuresBlock([]);
    expect(result).toBe("");
  });

  test("formats a single failure with structured context", () => {
    const result = buildRecentToolFailuresBlock([
      {
        toolName: "exec",
        args: { command: "bun test" },
        outputText: "Error: test suite failed with 3 failures",
        turn: 5,
      },
    ]);

    expect(result).toContain("[RecentToolFailures]");
    expect(result).toContain("tool=exec");
    expect(result).toContain("bun test");
    expect(result).toContain("3 failures");
  });

  test("limits output to maxEntries", () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      toolName: `tool_${i}`,
      args: {},
      outputText: `error ${i}`,
      turn: i,
    }));

    const result = buildRecentToolFailuresBlock(failures, { maxEntries: 3 });
    expect(result).toContain("tool_7");
    expect(result).toContain("tool_8");
    expect(result).toContain("tool_9");
    expect(result).not.toContain("tool_0");
  });

  test("truncates long output summaries", () => {
    const result = buildRecentToolFailuresBlock([
      {
        toolName: "exec",
        args: {},
        outputText: "x".repeat(500),
        turn: 1,
      },
    ]);

    expect(result).toContain("...");
    expect(result.length).toBeLessThan(600);
  });
});
