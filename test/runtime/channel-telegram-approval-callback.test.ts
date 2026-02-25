import { describe, expect, test } from "bun:test";
import {
  decodeTelegramApprovalCallback,
  encodeTelegramApprovalCallback,
} from "@brewva/brewva-channels-telegram";

describe("channel telegram approval callback", () => {
  const secret = "top-secret";

  test("encodes and decodes signed callback payload", () => {
    const encoded = encodeTelegramApprovalCallback(
      { requestId: "req-1234567890", actionId: "approve" },
      secret,
    );
    expect(encoded.startsWith("apv1:")).toBe(true);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(64);

    const decoded = decodeTelegramApprovalCallback(encoded, secret);
    expect(decoded).toEqual({ requestId: "req-1234567890", actionId: "approve" });
  });

  test("rejects invalid signature and malformed data", () => {
    const encoded = encodeTelegramApprovalCallback(
      { requestId: "req-1234567890", actionId: "approve" },
      secret,
    );
    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith("0") ? "1" : "0"}`;
    expect(decodeTelegramApprovalCallback(tampered, secret)).toBeNull();
    expect(decodeTelegramApprovalCallback("bad", secret)).toBeNull();
  });

  test("enforces Telegram callback data size limit", () => {
    expect(() =>
      encodeTelegramApprovalCallback(
        {
          requestId: "request-id-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          actionId: "action-yyyyyyyyyyyyyyyyyyyy",
        },
        secret,
      ),
    ).toThrow("callback data exceeds Telegram 64-byte limit");
  });
});
