import { describe, expect, test } from "bun:test";
import { parseArgs } from "@brewva/brewva-cli";

describe("brewva cli args", () => {
  test("prints Brewva help banner", () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
      const parsed = parseArgs(["--help"]);
      expect(parsed).toBeNull();
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output.includes("Brewva - AI-native coding agent CLI")).toBe(true);
    expect(output.includes("Usage:\n  brewva [options] [prompt]")).toBe(true);
  });

  test("defaults to interactive mode and keeps prompt", () => {
    const parsed = parseArgs(["fix", "failing", "tests"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.undo).toBe(false);
    expect(parsed!.replay).toBe(false);
    expect(parsed!.prompt).toBe("fix failing tests");
    expect(parsed!.modeExplicit).toBe(false);
  });

  test("supports one-shot print mode", () => {
    const parsed = parseArgs(["--print", "summarize", "changes"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("print-text");
    expect(parsed!.prompt).toBe("summarize changes");
    expect(parsed!.modeExplicit).toBe(true);
  });

  test("supports json print mode aliases", () => {
    const byJsonFlag = parseArgs(["--json", "inspect"]);
    expect(byJsonFlag).not.toBeNull();
    expect(byJsonFlag!.mode).toBe("print-json");

    const byMode = parseArgs(["--mode", "json", "inspect"]);
    expect(byMode).not.toBeNull();
    expect(byMode!.mode).toBe("print-json");
  });

  test("allows starting interactive mode without prompt", () => {
    const parsed = parseArgs([]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.prompt).toBeUndefined();
  });

  test("supports undo flag without requiring prompt", () => {
    const parsed = parseArgs(["--undo"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.undo).toBe(true);
    expect(parsed!.mode).toBe("interactive");
  });

  test("supports replay and explicit session id", () => {
    const parsed = parseArgs(["--replay", "--mode", "json", "--session", "session-123"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.replay).toBe(true);
    expect(parsed!.sessionId).toBe("session-123");
    expect(parsed!.mode).toBe("print-json");
  });

  test("supports daemon mode flag", () => {
    const parsed = parseArgs(["--daemon"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.daemon).toBe(true);
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.prompt).toBeUndefined();
  });

  test("supports channel mode telegram flags", () => {
    const parsed = parseArgs([
      "--channel",
      "telegram",
      "--telegram-token",
      "bot-token",
      "--telegram-callback-secret",
      "secret",
      "--telegram-poll-timeout",
      "15",
      "--telegram-poll-limit",
      "50",
      "--telegram-poll-retry-ms",
      "2500",
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed!.channel).toBe("telegram");
    expect(parsed!.channelConfig?.telegram?.token).toBe("bot-token");
    expect(parsed!.channelConfig?.telegram?.callbackSecret).toBe("secret");
    expect(parsed!.channelConfig?.telegram?.pollTimeoutSeconds).toBe(15);
    expect(parsed!.channelConfig?.telegram?.pollLimit).toBe(50);
    expect(parsed!.channelConfig?.telegram?.pollRetryMs).toBe(2500);
    expect(parsed!.mode).toBe("interactive");
  });

  test("rejects non-integer telegram polling flags", () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const parsed = parseArgs(["--channel", "telegram", "--telegram-poll-timeout", "1.5"]);
      expect(parsed).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(errors.some((line) => line.includes("--telegram-poll-timeout must be an integer"))).toBe(
      true,
    );
  });
});
