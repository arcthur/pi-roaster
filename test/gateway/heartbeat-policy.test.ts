import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHeartbeatPolicy } from "@brewva/brewva-gateway";

describe("heartbeat policy loader", () => {
  test("given valid heartbeat json block, when policy is loaded, then rules are parsed", () => {
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

  test("given no heartbeat json block, when policy is loaded, then bullet rules are parsed", () => {
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

  test("given empty policy file, when policy is loaded, then no rules are returned", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-policy-empty-"));
    const policyPath = join(root, "HEARTBEAT.md");
    try {
      writeFileSync(policyPath, "", "utf8");
      const policy = loadHeartbeatPolicy(policyPath);
      expect(policy.rules).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given malformed heartbeat json block, when policy is loaded, then loader falls back to bullet parsing", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-policy-malformed-"));
    const policyPath = join(root, "HEARTBEAT.md");
    try {
      writeFileSync(
        policyPath,
        [
          "```heartbeat",
          '{"rules":[{"id":"broken","intervalMinutes":15,"prompt":"Check"}',
          "```",
          "- every 20m: fallback runs",
        ].join("\n"),
        "utf8",
      );
      const policy = loadHeartbeatPolicy(policyPath);
      expect(policy.rules).toHaveLength(1);
      expect(policy.rules[0]?.intervalMinutes).toBe(20);
      expect(policy.rules[0]?.prompt).toBe("fallback runs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given invalid json rules, when policy is loaded, then zero interval and empty prompt rules are dropped", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-policy-invalid-rules-"));
    const policyPath = join(root, "HEARTBEAT.md");
    try {
      writeFileSync(
        policyPath,
        [
          "```heartbeat",
          JSON.stringify({
            rules: [
              { id: "zero", intervalMinutes: 0, prompt: "zero interval" },
              { id: "negative", intervalMinutes: -5, prompt: "negative interval" },
              { id: "empty-prompt", intervalMinutes: 15, prompt: "   " },
              { id: "ok", intervalMinutes: 10, prompt: "still valid" },
            ],
          }),
          "```",
        ].join("\n"),
        "utf8",
      );
      const policy = loadHeartbeatPolicy(policyPath);
      expect(policy.rules).toHaveLength(1);
      expect(policy.rules[0]?.id).toBe("ok");
      expect(policy.rules[0]?.intervalMinutes).toBe(10);
      expect(policy.rules[0]?.prompt).toBe("still valid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
