import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHeartbeatPolicy } from "@brewva/brewva-gateway";

describe("heartbeat policy loader", () => {
  test("parses json heartbeat fenced block", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-policy-"));
    const policyPath = join(root, "HEARTBEAT.md");
    try {
      writeFileSync(
        policyPath,
        [
          "# HEARTBEAT",
          "",
          "```heartbeat",
          '{"rules":[{"id":"nightly","intervalMinutes":15,"prompt":"Check backlog","sessionId":"ops"}]}',
          "```",
          "",
        ].join("\n"),
        "utf8",
      );

      const policy = loadHeartbeatPolicy(policyPath);
      expect(policy.rules.length).toBe(1);
      expect(policy.rules[0]?.id).toBe("nightly");
      expect(policy.rules[0]?.intervalMinutes).toBe(15);
      expect(policy.rules[0]?.prompt).toBe("Check backlog");
      expect(policy.rules[0]?.sessionId).toBe("ops");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to bullet syntax when json block missing", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-policy-"));
    const policyPath = join(root, "HEARTBEAT.md");
    try {
      writeFileSync(
        policyPath,
        ["- every 5m: summarize error budget", "- every 30m: scan pending merges"].join("\n"),
        "utf8",
      );

      const policy = loadHeartbeatPolicy(policyPath);
      expect(policy.rules.length).toBe(2);
      expect(policy.rules[0]?.intervalMinutes).toBe(5);
      expect(policy.rules[0]?.prompt).toBe("summarize error budget");
      expect(policy.rules[1]?.intervalMinutes).toBe(30);
      expect(policy.rules[1]?.prompt).toBe("scan pending merges");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
