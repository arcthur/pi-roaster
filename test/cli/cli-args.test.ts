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
    expect(output.includes("brewva onboard ...")).toBe(true);
    expect(output.includes("--agent <id>")).toBe(true);
  });

  test("prints CLI version", () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
      const parsed = parseArgs(["--version"]);
      expect(parsed).toBeNull();
    } finally {
      console.log = originalLog;
    }

    expect(logs.length).toBe(1);
    expect(logs[0]?.trim().length).toBeGreaterThan(0);
  });

  test("defaults to interactive mode and keeps prompt", () => {
    const parsed = parseArgs(["fix", "failing", "tests"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.backend).toBe("auto");
    expect(parsed!.undo).toBe(false);
    expect(parsed!.replay).toBe(false);
    expect(parsed!.prompt).toBe("fix failing tests");
    expect(parsed!.modeExplicit).toBe(false);
  });

  test("parses --agent and normalizes to canonical id", () => {
    const parsed = parseArgs(["--agent", "  Code Reviewer  ", "--print", "hello"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe("code-reviewer");
    expect(parsed!.mode).toBe("print-text");
  });

  test("supports explicit backend values", () => {
    const embedded = parseArgs(["--backend", "embedded", "--print", "hello"]);
    expect(embedded).not.toBeNull();
    expect(embedded!.backend).toBe("embedded");

    const gateway = parseArgs(["--backend", "gateway", "--print", "hello"]);
    expect(gateway).not.toBeNull();
    expect(gateway!.backend).toBe("gateway");
  });

  test("rejects invalid backend value", () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const parsed = parseArgs(["--backend", "invalid-backend", "--print", "hello"]);
      expect(parsed).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(
      errors.some((line) => line.includes('--backend must be "auto", "embedded", or "gateway"')),
    ).toBe(true);
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

  test("rejects combining --undo and --replay", () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const parsed = parseArgs(["--undo", "--replay"]);
      expect(parsed).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(errors.some((line) => line.includes("--undo cannot be combined with --replay"))).toBe(
      true,
    );
  });

  test("rejects combining --replay with --task-file", () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const parsed = parseArgs(["--replay", "--task-file", "task.json"]);
      expect(parsed).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(
      errors.some((line) => line.includes("--undo/--replay cannot be combined with --task")),
    ).toBe(true);
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
