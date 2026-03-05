import { describe, expect, test } from "bun:test";
import { createExecTool, createProcessTool } from "@brewva/brewva-tools";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function fakeContext(sessionId: string): any {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function createRuntimeForExecTests(input?: {
  mode?: "permissive" | "standard" | "strict";
  backend?: "host" | "sandbox" | "best_available";
  enforceIsolation?: boolean;
  fallbackToHost?: boolean;
  commandDenyList?: string[];
  serverUrl?: string;
}) {
  const mode = input?.mode ?? "standard";
  const enforceIsolation = input?.enforceIsolation ?? false;
  const normalizedBackend =
    enforceIsolation || mode === "strict" ? "sandbox" : (input?.backend ?? "best_available");
  const normalizedFallbackToHost =
    enforceIsolation || mode === "strict" ? false : (input?.fallbackToHost ?? false);
  const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const runtime = {
    config: {
      security: {
        mode,
        sanitizeContext: true,
        execution: {
          backend: normalizedBackend,
          enforceIsolation,
          fallbackToHost: normalizedFallbackToHost,
          commandDenyList: input?.commandDenyList ?? [],
          sandbox: {
            serverUrl: input?.serverUrl ?? "http://127.0.0.1:5555",
            defaultImage: "microsandbox/node",
            memory: 64,
            cpus: 1,
            timeout: 1,
          },
        },
      },
    },
    events: {
      record: (event: { type?: string; payload?: Record<string, unknown> }) => {
        events.push(event);
        return undefined;
      },
    },
  };
  return { runtime: runtime as any, events };
}

describe("exec/process tool flow", () => {
  test("exec backgrounds and process poll waits for completion", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool();
    const sessionId = "s13-exec-process";

    const started = await execTool.execute(
      "tc-exec-start",
      {
        command: "node -e \"setTimeout(() => { console.log('done') }, 150)\"",
        yieldMs: 10,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const startDetails = started.details as { status?: string; sessionId?: string };
    expect(startDetails.status).toBe("running");
    expect(typeof startDetails.sessionId).toBe("string");

    const sessionHandle = startDetails.sessionId ?? "";
    const polled = await processTool.execute(
      "tc-exec-poll",
      {
        action: "poll",
        sessionId: sessionHandle,
        timeout: 2_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const pollText = extractTextContent(polled);
    expect(pollText.includes("done")).toBe(true);
    expect((polled.details as { status?: string }).status).toBe("completed");
  });

  test("process kill stops a background session", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool();
    const sessionId = "s13-process-kill";

    const started = await execTool.execute(
      "tc-exec-start",
      {
        command: "node -e \"setInterval(() => process.stdout.write('tick\\\\n'), 40)\"",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const sessionHandle = (started.details as { sessionId?: string }).sessionId;
    expect(typeof sessionHandle).toBe("string");

    const killed = await processTool.execute(
      "tc-process-kill",
      {
        action: "kill",
        sessionId: sessionHandle,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect((killed.details as { status?: string }).status).toBe("failed");

    const polled = await processTool.execute(
      "tc-process-poll",
      {
        action: "poll",
        sessionId: sessionHandle,
        timeout: 1_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const pollStatus = (polled.details as { status?: string }).status;
    expect(pollStatus === "completed" || pollStatus === "failed").toBe(true);
  });

  test("exec throws on non-zero exit code", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-fail";

    expect(
      execTool.execute(
        "tc-exec-fail",
        {
          command: 'node -e "process.exit(2)"',
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("Process exited");
  });

  test("standard mode falls back to host when sandbox backend is unavailable", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:2",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-fallback-host";

    const result = await execTool.execute(
      "tc-exec-fallback-host",
      {
        command: "echo Authorization: Bearer super-secret-token && echo fallback-ok",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result).includes("fallback-ok")).toBe(true);
    expect((result.details as { backend?: string }).backend).toBe("host");
    expect(events.some((event) => event.type === "exec_routed")).toBe(true);
    expect(events.some((event) => event.type === "exec_sandbox_error")).toBe(true);
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(true);
    const routed = events.find((event) => event.type === "exec_routed");
    const routedPayload = routed?.payload ?? {};
    expect(routedPayload.routingPolicy).toBe("best_available");
    expect(routedPayload.command).toBeUndefined();
    expect(typeof routedPayload.commandHash).toBe("string");
    expect((routedPayload.commandHash as string).length).toBe(64);
    const redacted = routedPayload.commandRedacted;
    expect(typeof redacted).toBe("string");
    expect((redacted as string).includes("<redacted>")).toBe(true);
    expect((redacted as string).includes("super-secret-token")).toBe(false);
  });

  test("standard mode with backend=best_available falls back to host even when fallbackToHost is false", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "best_available",
      fallbackToHost: false,
      serverUrl: "http://127.0.0.1:4",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-best-available-implicit-fallback";

    const result = await execTool.execute(
      "tc-exec-best-available-implicit-fallback",
      {
        command: "echo best-available-implicit-fallback",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(result).includes("best-available-implicit-fallback")).toBe(true);
    expect((result.details as { backend?: string }).backend).toBe("host");
    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed?.payload?.configuredBackend).toBe("best_available");
    expect(routed?.payload?.resolvedBackend).toBe("sandbox");
    expect(routed?.payload?.routingPolicy).toBe("best_available");
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(true);
  });

  test("standard mode with backend=best_available falls back to host when fallbackToHost is true", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "best_available",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:3",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-best-available-fallback-enabled";

    const result = await execTool.execute(
      "tc-exec-best-available-fallback-enabled",
      {
        command: "echo best-available-fallback-enabled",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result).includes("best-available-fallback-enabled")).toBe(true);
    expect((result.details as { backend?: string }).backend).toBe("host");
    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed?.payload?.configuredBackend).toBe("best_available");
    expect(routed?.payload?.resolvedBackend).toBe("sandbox");
    expect(routed?.payload?.fallbackToHost).toBe(true);
    expect(routed?.payload?.routingPolicy).toBe("best_available");
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(true);
  });

  test("standard mode caches sandbox failures and skips immediate sandbox retries", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-fallback-cached";

    const first = await execTool.execute(
      "tc-exec-fallback-cached-1",
      {
        command: "echo first-fallback",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(first).includes("first-fallback")).toBe(true);

    const second = await execTool.execute(
      "tc-exec-fallback-cached-2",
      {
        command: "echo second-fallback",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(second).includes("second-fallback")).toBe(true);

    const sandboxErrors = events.filter((event) => event.type === "exec_sandbox_error");
    expect(sandboxErrors).toHaveLength(1);
    const fallbackEvents = events.filter((event) => event.type === "exec_fallback_host");
    expect(fallbackEvents).toHaveLength(2);
    const secondFallbackPayload = fallbackEvents[1]?.payload;
    expect(secondFallbackPayload?.reason).toBe("sandbox_unavailable_cached");
    const routedEvents = events.filter((event) => event.type === "exec_routed");
    expect(routedEvents).toHaveLength(1);
  });

  test("standard mode pins session after repeated sandbox failures and bypasses sandbox retries", async () => {
    const firstAttempt = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:11",
    });
    const secondAttempt = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:12",
    });
    const thirdAttempt = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:13",
    });

    const sessionId = "s13-exec-session-pinned";

    const firstExec = createExecTool({ runtime: firstAttempt.runtime });
    const secondExec = createExecTool({ runtime: secondAttempt.runtime });
    const thirdExec = createExecTool({ runtime: thirdAttempt.runtime });

    const first = await firstExec.execute(
      "tc-exec-session-pinned-1",
      {
        command: "echo first-session-pin",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(first).includes("first-session-pin")).toBe(true);

    const second = await secondExec.execute(
      "tc-exec-session-pinned-2",
      {
        command: "echo second-session-pin",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(second).includes("second-session-pin")).toBe(true);

    const secondFallback = secondAttempt.events.find(
      (event) => event.type === "exec_fallback_host",
    );
    expect(secondFallback?.payload?.reason).toBe("sandbox_execution_error");
    expect(typeof secondFallback?.payload?.sessionPinnedUntil).toBe("number");
    expect(typeof secondFallback?.payload?.sessionPinTtlMs).toBe("number");
    expect((secondFallback?.payload?.sessionPinTtlMs as number) > 0).toBe(true);

    const third = await thirdExec.execute(
      "tc-exec-session-pinned-3",
      {
        command: "echo third-session-pin",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(third).includes("third-session-pin")).toBe(true);

    expect(thirdAttempt.events.some((event) => event.type === "exec_sandbox_error")).toBe(false);
    const thirdFallback = thirdAttempt.events.find((event) => event.type === "exec_fallback_host");
    expect(thirdFallback?.payload?.reason).toBe("sandbox_unavailable_session_pinned");
    expect(typeof thirdFallback?.payload?.sessionPinMsRemaining).toBe("number");
    expect((thirdFallback?.payload?.sessionPinMsRemaining as number) > 0).toBe(true);
  });

  test("strict mode fails closed when sandbox backend is unavailable", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "strict",
      backend: "best_available",
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-strict-fail-closed";

    expect(
      execTool.execute(
        "tc-exec-strict-fail-closed",
        {
          command: "echo blocked",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    expect(events.some((event) => event.type === "exec_routed")).toBe(true);
    expect(events.some((event) => event.type === "exec_sandbox_error")).toBe(true);
    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
  });

  test("standard sandbox mode fails closed when fallbackToHost is false", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "sandbox",
      fallbackToHost: false,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-sandbox-fail-closed";

    expect(
      execTool.execute(
        "tc-exec-sandbox-fail-closed",
        {
          command: "echo should-block",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed?.payload?.routingPolicy).toBe("fail_closed");
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
  });

  test("enforce isolation overrides permissive host routing and fails closed", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
      enforceIsolation: true,
      fallbackToHost: true,
      serverUrl: "http://127.0.0.1:1",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-enforce-isolation";

    expect(
      execTool.execute(
        "tc-exec-enforce-isolation",
        {
          command: "echo must-block-when-sandbox-down",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const routed = events.find((event) => event.type === "exec_routed");
    expect(routed).toBeDefined();
    expect(routed?.payload?.configuredBackend).toBe("sandbox");
    expect(routed?.payload?.resolvedBackend).toBe("sandbox");
    expect(routed?.payload?.routingPolicy).toBe("fail_closed");
    expect(routed?.payload?.fallbackToHost).toBe(false);
    expect(routed?.payload?.enforceIsolation).toBe(true);

    expect(events.some((event) => event.type === "exec_sandbox_error")).toBe(true);
    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
    expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
  });

  test("command deny list blocks before execution", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
      commandDenyList: ["node"],
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-deny-list";

    expect(
      execTool.execute(
        "tc-exec-deny-list",
        {
          command: "node -e \"console.log('should-not-run')\"",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
    const blocked = events.find((event) => event.type === "exec_blocked_isolation");
    const denyListPolicy = blocked?.payload?.denyListPolicy;
    expect(typeof denyListPolicy).toBe("string");
    expect((denyListPolicy as string).includes("best-effort")).toBe(true);
  });

  test("exec rejects brewva tool-name command misroutes", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-tool-misroute";

    expect(
      execTool.execute(
        "tc-exec-tool-misroute",
        {
          command: "session_compact",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const blockedEvent = events.find((event) => event.type === "exec_blocked_isolation");
    expect(blockedEvent?.payload?.blockedAsToolNameMisroute).toBe(true);
    expect(blockedEvent?.payload?.suggestedTool).toBe("session_compact");
  });

  test("command deny list blocks shell wrapper inline scripts", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
      commandDenyList: ["node"],
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-deny-shell-wrapper";

    expect(
      execTool.execute(
        "tc-exec-deny-shell-wrapper",
        {
          command: 'sh -lc "node -e \\"console.log(123)\\""',
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
  });
});
