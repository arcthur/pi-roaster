import { describe, expect, test } from "bun:test";
import { parseArgs } from "@brewva/brewva-cli";
import { captureConsole } from "../helpers.js";

describe("brewva cli args", () => {
  test("given --help, when parsing args, then help banner is printed", () => {
    const { result, logs } = captureConsole(() => parseArgs(["--help"]));
    expect(result).toBeNull();

    const output = logs.join("\n");
    expect(output.includes("Brewva - AI-native coding agent CLI")).toBe(true);
    expect(output.includes("Usage:\n  brewva [options] [prompt]")).toBe(true);
    expect(output.includes("brewva onboard ...")).toBe(true);
    expect(output.includes("--agent <id>")).toBe(true);
  });

  test("given --version, when parsing args, then version output is printed", () => {
    const { result, logs } = captureConsole(() => parseArgs(["--version"]));
    expect(result).toBeNull();

    expect(logs.length).toBe(1);
    expect(logs[0]?.trim().length).toBeGreaterThan(0);
  });

  test("given prompt tokens without mode flags, when parsing args, then mode defaults to interactive and prompt is preserved", () => {
    const parsed = parseArgs(["fix", "failing", "tests"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.backend).toBe("auto");
    expect(parsed!.undo).toBe(false);
    expect(parsed!.replay).toBe(false);
    expect(parsed!.prompt).toBe("fix failing tests");
    expect(parsed!.modeExplicit).toBe(false);
  });

  test("given --agent with mixed casing and spaces, when parsing args, then canonical agent id is normalized", () => {
    const parsed = parseArgs(["--agent", "  Code Reviewer  ", "--print", "hello"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe("code-reviewer");
    expect(parsed!.mode).toBe("print-text");
  });

  test("given valid --backend values, when parsing args, then backend is accepted", () => {
    const embedded = parseArgs(["--backend", "embedded", "--print", "hello"]);
    expect(embedded).not.toBeNull();
    expect(embedded!.backend).toBe("embedded");

    const gateway = parseArgs(["--backend", "gateway", "--print", "hello"]);
    expect(gateway).not.toBeNull();
    expect(gateway!.backend).toBe("gateway");
  });

  test("given invalid --backend value, when parsing args, then parser returns error", () => {
    const { result, errors } = captureConsole(() =>
      parseArgs(["--backend", "invalid-backend", "--print", "hello"]),
    );
    expect(result).toBeNull();
    expect(
      errors.some((line) => line.includes('--backend must be "auto", "embedded", or "gateway"')),
    ).toBe(true);
  });

  test("given --print with prompt, when parsing args, then mode is print-text", () => {
    const parsed = parseArgs(["--print", "summarize", "changes"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("print-text");
    expect(parsed!.prompt).toBe("summarize changes");
    expect(parsed!.modeExplicit).toBe(true);
  });

  test("given json mode flags, when parsing args, then mode resolves to print-json", () => {
    const byJsonFlag = parseArgs(["--json", "inspect"]);
    expect(byJsonFlag).not.toBeNull();
    expect(byJsonFlag!.mode).toBe("print-json");

    const byMode = parseArgs(["--mode", "json", "inspect"]);
    expect(byMode).not.toBeNull();
    expect(byMode!.mode).toBe("print-json");
  });

  test("given no prompt and no mode flag, when parsing args, then interactive mode is allowed", () => {
    const parsed = parseArgs([]);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.prompt).toBeUndefined();
  });

  test("given --undo without prompt, when parsing args, then undo is enabled in interactive mode", () => {
    const parsed = parseArgs(["--undo"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.undo).toBe(true);
    expect(parsed!.mode).toBe("interactive");
  });

  test("given --replay with --session, when parsing args, then replay mode and session id are applied", () => {
    const parsed = parseArgs(["--replay", "--mode", "json", "--session", "session-123"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.replay).toBe(true);
    expect(parsed!.sessionId).toBe("session-123");
    expect(parsed!.mode).toBe("print-json");
  });

  test("given --undo and --replay together, when parsing args, then parser rejects conflicting flags", () => {
    const { result, errors } = captureConsole(() => parseArgs(["--undo", "--replay"]));
    expect(result).toBeNull();
    expect(errors.some((line) => line.includes("--undo cannot be combined with --replay"))).toBe(
      true,
    );
  });

  test("given --replay with --task-file, when parsing args, then parser rejects conflicting flags", () => {
    const { result, errors } = captureConsole(() =>
      parseArgs(["--replay", "--task-file", "task.json"]),
    );
    expect(result).toBeNull();
    expect(
      errors.some((line) => line.includes("--undo/--replay cannot be combined with --task")),
    ).toBe(true);
  });

  test("given --daemon, when parsing args, then daemon flag is enabled", () => {
    const parsed = parseArgs(["--daemon"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.daemon).toBe(true);
    expect(parsed!.mode).toBe("interactive");
    expect(parsed!.prompt).toBeUndefined();
  });

  test("given telegram channel flags, when parsing args, then telegram channel config is populated", () => {
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

  test("given --channel telegram without token, when parsing args, then parser reports missing telegram token", () => {
    const { result, errors } = captureConsole(() => parseArgs(["--channel", "telegram"]));
    expect(result).toBeNull();
    expect(
      errors.some((line) =>
        line.includes("--telegram-token is required when --channel telegram is set"),
      ),
    ).toBe(true);
  });

  test("given non-integer telegram polling flag, when parsing args, then parser reports validation error", () => {
    const { result, errors } = captureConsole(() =>
      parseArgs(["--channel", "telegram", "--telegram-poll-timeout", "1.5"]),
    );
    expect(result).toBeNull();
    expect(errors.some((line) => line.includes("--telegram-poll-timeout must be an integer"))).toBe(
      true,
    );
  });
});
