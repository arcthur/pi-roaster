import { describe, expect, test } from "bun:test";
import { validateParamsForMethod, validateRequestFrame } from "@brewva/brewva-gateway";

describe("gateway protocol validator", () => {
  test("given connect params with auth token and challenge nonce, when validating params, then validation succeeds", () => {
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

  test("given connect params without auth token and challenge nonce, when validating params, then validation fails", () => {
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

  test("given valid sessions.close params, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.close", {
      sessionId: "session-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.sessionId).toBe("session-1");
  });

  test("given sessions.close without sessionId, when validating params, then validation fails", () => {
    const result = validateParamsForMethod("sessions.close", {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.includes("required property")).toBe(true);
  });

  test("given sessions.close with extra property, when validating params, then validation fails", () => {
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

  test("given valid sessions.subscribe params, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("sessions.subscribe", {
      sessionId: "session-2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params.sessionId).toBe("session-2");
  });

  test("given sessions.send with turnId, when validating params, then validation succeeds", () => {
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

  test("given sessions.open with optional agentId, when validating params, then validation succeeds", () => {
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

  test("given sessions.unsubscribe with extra property, when validating params, then validation fails", () => {
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

  test("given request frame with non-empty traceId, when validating frame, then frame is accepted", () => {
    const ok = validateRequestFrame({
      type: "req",
      id: "req-1",
      traceId: "trace-1",
      method: "health",
      params: {},
    });
    expect(ok).toBe(true);
  });

  test("given request frame with empty traceId, when validating frame, then frame is rejected", () => {
    const ok = validateRequestFrame({
      type: "req",
      id: "req-2",
      traceId: "",
      method: "health",
      params: {},
    });
    expect(ok).toBe(false);
  });

  test("given gateway.rotate-token with empty params, when validating params, then validation succeeds", () => {
    const result = validateParamsForMethod("gateway.rotate-token", {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.params).toEqual({});
  });

  test("given gateway.rotate-token with unsupported params, when validating params, then validation fails", () => {
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
