import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredLogger } from "@brewva/brewva-gateway";

describe("gateway logger rotation", () => {
  test("given pre-existing rotated files, when logger exceeds size threshold, then rotation still succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-log-"));
    const logFilePath = join(root, "gateway.log");
    try {
      const logger = new StructuredLogger({
        logFilePath,
        maxBytes: 256 * 1024,
        maxFiles: 2,
      });

      const large = "x".repeat(300_000);
      logger.info(large);
      logger.info(large);
      logger.info(large);

      expect(existsSync(logFilePath)).toBe(true);
      expect(existsSync(`${logFilePath}.1`)).toBe(true);
      expect(existsSync(`${logFilePath}.2`)).toBe(true);

      const current = readFileSync(logFilePath, "utf8");
      const rotated1 = readFileSync(`${logFilePath}.1`, "utf8");
      expect(current.length).toBeGreaterThan(0);
      expect(rotated1.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
