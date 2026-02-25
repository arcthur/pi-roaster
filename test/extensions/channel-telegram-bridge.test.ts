import { describe, expect, test } from "bun:test";
import { createRuntimeTelegramChannelBridge } from "@brewva/brewva-extensions";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { resolveRequestUrl } from "../helpers.js";

interface RuntimeLike {
  events: {
    record: (input: Record<string, unknown>) => void;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  if (!resolve || !reject) {
    throw new Error("failed to initialize deferred");
  }
  return { promise, resolve, reject };
}

function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

const OUTBOUND_TURN: TurnEnvelope = {
  schema: "brewva.turn.v1",
  kind: "assistant",
  sessionId: "channel:session",
  turnId: "turn-1",
  channel: "telegram",
  conversationId: "12345",
  timestamp: 1_700_000_000_000,
  parts: [{ type: "text", text: "hello outbound" }],
};

describe("runtime telegram channel bridge helper", () => {
  test("given polling transport, when telegram update arrives, then runtime bridge emits ingested turn telemetry", async () => {
    const events: Record<string, unknown>[] = [];
    const runtime: RuntimeLike = {
      events: {
        record: (input) => {
          events.push(input);
        },
      },
    };
    const inboundTurns: TurnEnvelope[] = [];
    const inboundSeen = createDeferred<void>();
    const secondPollGate = createDeferred<Response>();
    let fetchCalls = 0;
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 7,
                  date: 1_700_000_000,
                  chat: { id: 12345, type: "private" },
                  from: { id: 42, is_bot: false, first_name: "Ada" },
                  text: "hello inbound",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (!init?.signal) {
        throw new Error("expected abort signal");
      }
      init.signal.addEventListener(
        "abort",
        () => {
          secondPollGate.reject(createAbortError());
        },
        { once: true },
      );
      return secondPollGate.promise;
    };

    const { bridge } = createRuntimeTelegramChannelBridge({
      runtime: runtime as unknown as BrewvaRuntime,
      token: "bot-token",
      transport: {
        fetchImpl,
        poll: { timeoutSeconds: 0, retryDelayMs: 0 },
      },
      onInboundTurn: async (turn) => {
        inboundTurns.push(turn);
        inboundSeen.resolve();
      },
    });

    await bridge.start();
    await inboundSeen.promise;
    await bridge.stop();

    expect(inboundTurns).toHaveLength(1);
    expect(inboundTurns[0]?.kind).toBe("user");
    expect(events.some((entry) => entry.type === "channel_turn_ingested")).toBe(true);
  });

  test("given outbound assistant turn, when bridge sends telegram message, then emitted telemetry is recorded", async () => {
    const events: Record<string, unknown>[] = [];
    const runtime: RuntimeLike = {
      events: {
        record: (input) => {
          events.push(input);
        },
      },
    };
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = resolveRequestUrl(input);
      if (!url.endsWith("/sendMessage")) {
        throw new Error(`unexpected endpoint: ${url}`);
      }
      if (init?.method !== "POST") {
        throw new Error("expected POST request");
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 99 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const { bridge } = createRuntimeTelegramChannelBridge({
      runtime: runtime as unknown as BrewvaRuntime,
      token: "bot-token",
      transport: { fetchImpl },
      onInboundTurn: async () => undefined,
    });

    const result = await bridge.sendTurn(OUTBOUND_TURN);

    expect(result.providerMessageId).toBe("99");
    expect(events.some((entry) => entry.type === "channel_turn_emitted")).toBe(true);
  });
});
