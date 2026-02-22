import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileGatewayStateStore } from "@brewva/brewva-gateway";

describe("gateway file state store", () => {
  test("writes and reads token with newline normalization", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-"));
    try {
      const store = new FileGatewayStateStore();
      const tokenPath = join(root, "gateway.token");
      store.writeToken(tokenPath, "token-123");

      const raw = readFileSync(tokenPath, "utf8");
      expect(raw).toBe("token-123\n");
      expect(store.readToken(tokenPath)).toBe("token-123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads children registry and ignores malformed rows", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-"));
    try {
      const store = new FileGatewayStateStore();
      const registryPath = join(root, "children.json");
      writeFileSync(
        registryPath,
        JSON.stringify(
          [
            { sessionId: "s1", pid: 1001, startedAt: 100 },
            { sessionId: "", pid: 1002, startedAt: 200 },
            { sessionId: "s3", pid: 0, startedAt: 300 },
            { sessionId: "s4", pid: 1004 },
            "bad-row",
          ],
          null,
          2,
        ),
        "utf8",
      );

      const rows = store.readChildrenRegistry(registryPath);
      expect(rows).toEqual([{ sessionId: "s1", pid: 1001, startedAt: 100 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes registry atomically without stale tmp file", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-"));
    try {
      const store = new FileGatewayStateStore();
      const registryPath = join(root, "children.json");
      store.writeChildrenRegistry(registryPath, [{ sessionId: "s1", pid: 1001, startedAt: 123 }]);

      expect(existsSync(registryPath)).toBe(true);
      expect(existsSync(`${registryPath}.tmp`)).toBe(false);
      expect(store.readChildrenRegistry(registryPath)).toEqual([
        { sessionId: "s1", pid: 1001, startedAt: 123 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
