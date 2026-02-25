import { describe, expect, test } from "bun:test";
import {
  TelegramHttpTransport,
  type TelegramFetchLike,
  type TelegramHttpTransportOptions,
  type TelegramOutboundRequest,
  type TelegramUpdate,
} from "@brewva/brewva-channels-telegram";
import { assertRejectsWithMessage, resolveRequestUrl } from "../helpers.js";

interface FetchCall {
  url: string;
  method: string;
  bodyJson: Record<string, unknown>;
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

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetchStub(
  responders: Array<(url: string, init: RequestInit) => Promise<Response>>,
): {
  fetchImpl: TelegramFetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: TelegramFetchLike = async (input, init) => {
    const url = resolveRequestUrl(input);
    const resolvedInit = init ?? {};
    const method = resolvedInit.method ?? "GET";
    const bodyRaw = typeof resolvedInit.body === "string" ? resolvedInit.body : "{}";
    const bodyJson = JSON.parse(bodyRaw) as Record<string, unknown>;
    calls.push({ url, method, bodyJson });

    const responder = responders.shift();
    if (!responder) {
      throw new Error(`unexpected fetch call: ${url}`);
    }
    return responder(url, resolvedInit);
  };

  return { fetchImpl, calls };
}

function createUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      date: 1_700_000_000,
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ada" },
      text: "hello",
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 5;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

function createTransport(
  options: Partial<TelegramHttpTransportOptions> & { token?: string } = {},
): TelegramHttpTransport {
  return new TelegramHttpTransport({
    token: options.token ?? "bot-token",
    ...options,
  });
}

describe("channel telegram http transport", () => {
  test("polls getUpdates and advances offset only after onUpdate success", async () => {
    const secondPollGate = createDeferred<Response>();
    const { fetchImpl, calls } = createFetchStub([
      async () =>
        createJsonResponse({
          ok: true,
          result: [createUpdate(10)],
        }),
      async (_url, init) => {
        if (!init.signal) {
          throw new Error("expected abort signal on polling request");
        }
        if (init.signal.aborted) {
          throw createAbortError();
        }
        init.signal.addEventListener(
          "abort",
          () => {
            secondPollGate.reject(createAbortError());
          },
          { once: true },
        );
        return secondPollGate.promise;
      },
    ]);

    const seen: TelegramUpdate[] = [];
    const firstUpdateSeen = createDeferred<void>();
    const transport = createTransport({
      fetchImpl,
      poll: { timeoutSeconds: 0, retryDelayMs: 0 },
    });

    await transport.start({
      onUpdate: async (update) => {
        seen.push(update);
        firstUpdateSeen.resolve();
      },
    });
    await firstUpdateSeen.promise;
    await waitFor(() => calls.length >= 2);
    await transport.stop();

    expect(seen.map((entry) => entry.update_id)).toEqual([10]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botbot-token/getUpdates");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.bodyJson.offset).toBeUndefined();
    expect(calls[1]?.bodyJson.offset).toBe(11);
  });

  test("keeps offset uncommitted and reports error when handler throws", async () => {
    const errors: string[] = [];
    const secondPollGate = createDeferred<Response>();
    const { fetchImpl, calls } = createFetchStub([
      async () =>
        createJsonResponse({
          ok: true,
          result: [createUpdate(30)],
        }),
      async (_url, init) => {
        if (!init.signal) {
          throw new Error("expected abort signal on polling request");
        }
        if (init.signal.aborted) {
          throw createAbortError();
        }
        init.signal.addEventListener(
          "abort",
          () => {
            secondPollGate.reject(createAbortError());
          },
          { once: true },
        );
        return secondPollGate.promise;
      },
    ]);

    const transport = createTransport({
      fetchImpl,
      poll: { timeoutSeconds: 0, retryDelayMs: 0 },
      onError: async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
      },
    });

    await transport.start({
      onUpdate: async () => {
        throw new Error("turn handler failed");
      },
    });

    await waitFor(() => calls.length >= 2);
    await transport.stop();

    expect(errors).toContain("turn handler failed");
    expect(calls[0]?.bodyJson.offset).toBeUndefined();
    expect(calls[1]?.bodyJson.offset).toBeUndefined();
  });

  test("maps send response message_id to providerMessageId", async () => {
    const request: TelegramOutboundRequest = {
      method: "sendMessage",
      params: { chat_id: "123", text: "hello" },
    };
    const { fetchImpl, calls } = createFetchStub([
      async () =>
        createJsonResponse({
          ok: true,
          result: { message_id: 777 },
        }),
    ]);

    const transport = createTransport({ fetchImpl });
    const result = await transport.send(request);

    expect(result).toEqual({ providerMessageId: 777 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(calls[0]?.bodyJson).toEqual({ chat_id: "123", text: "hello" });
  });

  test("throws on telegram api errors for send requests", async () => {
    const request: TelegramOutboundRequest = {
      method: "sendMessage",
      params: { chat_id: "123", text: "hello" },
    };
    const { fetchImpl } = createFetchStub([
      async () =>
        createJsonResponse({
          ok: false,
          error_code: 403,
          description: "bot was blocked by the user",
        }),
    ]);

    const transport = createTransport({ fetchImpl });
    await assertRejectsWithMessage(
      () => transport.send(request),
      "telegram api sendMessage failed: code=403 bot was blocked by the user",
    );
  });

  test("start and stop are idempotent", async () => {
    const { fetchImpl } = createFetchStub([
      async (_url, init) => {
        if (!init.signal) {
          throw new Error("expected signal");
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              reject(createAbortError());
            },
            { once: true },
          );
        });
      },
    ]);
    const transport = createTransport({
      fetchImpl,
      poll: { timeoutSeconds: 0, retryDelayMs: 0 },
    });

    await transport.start({ onUpdate: async () => undefined });
    await transport.start({ onUpdate: async () => undefined });
    await transport.stop();
    await transport.stop();
  });
});
