import { describe, expect, test } from "bun:test";
import { validateParamsForMethod, validateRequestFrame } from "@brewva/brewva-gateway";

describe("gateway protocol validator", () => {
  test("accepts connect params with strict required auth and challenge", () => {
    const result = validateParamsForMethod("connect", {
      protocol: 1,
      client: {
        id: "client-1",
        version: "0.1.0",
      },
      auth: {
        token: "token-1",
      },
      challengeNonce: "nonce-1",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects connect params without auth token or challenge nonce", () => {
    const result = validateParamsForMethod("connect", {
      protocol: 1,
      client: {
        id: "client-1",
        version: "0.1.0",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.includes("required property")).toBe(true);
  });

  test("accepts sessions.close params", () => {
    const result = validateParamsForMethod("sessions.close", {
      sessionId: "session-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.sessionId).toBe("session-1");
  });

  test("rejects sessions.close params without sessionId", () => {
    const result = validateParamsForMethod("sessions.close", {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.includes("required property")).toBe(true);
  });

  test("rejects additional properties for sessions.close", () => {
    const result = validateParamsForMethod("sessions.close", {
      sessionId: "session-1",
      extra: "not-allowed",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.includes("unexpected property 'extra'")).toBe(true);
  });

  test("accepts sessions.subscribe params", () => {
    const result = validateParamsForMethod("sessions.subscribe", {
      sessionId: "session-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.sessionId).toBe("session-2");
  });

  test("accepts sessions.send with turnId", () => {
    const result = validateParamsForMethod("sessions.send", {
      sessionId: "session-3",
      prompt: "hello",
      turnId: "turn-3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.turnId).toBe("turn-3");
  });

  test("accepts sessions.open with optional agentId", () => {
    const result = validateParamsForMethod("sessions.open", {
      sessionId: "session-5",
      cwd: "/tmp/workspace",
      configPath: ".brewva/brewva.json",
      model: "openai/gpt-5",
      agentId: "code-reviewer",
      enableExtensions: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.agentId).toBe("code-reviewer");
  });

  test("rejects sessions.unsubscribe params with extra property", () => {
    const result = validateParamsForMethod("sessions.unsubscribe", {
      sessionId: "session-4",
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.includes("unexpected property 'extra'")).toBe(true);
  });

  test("accepts request frame with traceId", () => {
    const ok = validateRequestFrame({
      type: "req",
      id: "req-1",
      traceId: "trace-1",
      method: "health",
      params: {},
    });
    expect(ok).toBe(true);
  });

  test("rejects request frame with empty traceId", () => {
    const ok = validateRequestFrame({
      type: "req",
      id: "req-2",
      traceId: "",
      method: "health",
      params: {},
    });
    expect(ok).toBe(false);
  });

  test("accepts gateway.rotate-token empty params", () => {
    const result = validateParamsForMethod("gateway.rotate-token", {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params).toEqual({});
  });

  test("rejects gateway.rotate-token params with extra property", () => {
    const result = validateParamsForMethod("gateway.rotate-token", {
      graceMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.includes("unexpected property 'graceMs'")).toBe(true);
  });
});
