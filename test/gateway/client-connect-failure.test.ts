import { describe, expect, test } from "bun:test";
import { connectGatewayClient } from "@brewva/brewva-gateway";
import { WebSocketServer, type RawData } from "ws";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

describe("gateway client handshake failure", () => {
  test("given rejected connect handshake, when client attempts connect, then socket closes and unauthorized error is returned", async () => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
    });
    const closeEvents: Array<{ code: number }> = [];

    await new Promise<void>((resolveListening, rejectListening) => {
      server.once("listening", () => resolveListening());
      server.once("error", rejectListening);
    });

    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: {
            nonce: "nonce-1",
            ts: Date.now(),
          },
          seq: 1,
        }),
      );

      socket.on("message", (raw) => {
        const text = rawToText(raw);
        const parsed = JSON.parse(text) as { id?: string; method?: string };
        if (parsed.method !== "connect") {
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: parsed.id ?? "unknown",
            ok: false,
            error: {
              code: "unauthorized",
              message: "invalid token",
            },
          }),
        );
      });
      socket.on("close", (code) => {
        closeEvents.push({ code });
      });
    });

    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("server address is not bound");
    }

    let connectError: unknown;
    try {
      await connectGatewayClient({
        host: "127.0.0.1",
        port: address.port,
        token: "wrong-token",
        connectTimeoutMs: 500,
        requestTimeoutMs: 500,
      });
    } catch (error) {
      connectError = error;
    }
    expect(connectError).toBeInstanceOf(Error);
    if (!(connectError instanceof Error)) {
      throw new Error("expected connect handshake to fail");
    }
    expect(connectError.message).toBe("[unauthorized] invalid token");

    // Allow close event to propagate on server side.
    await sleep(200);
    expect(closeEvents.length).toBe(1);

    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  });
});
