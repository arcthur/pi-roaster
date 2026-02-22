import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GatewayPidRecord {
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  cwd: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidRecord(pidFilePath: string): GatewayPidRecord | undefined {
  const filePath = resolve(pidFilePath);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const value = parsed as Partial<GatewayPidRecord>;
    if (
      typeof value.pid === "number" &&
      typeof value.port === "number" &&
      typeof value.startedAt === "number" &&
      typeof value.cwd === "string"
    ) {
      return {
        pid: value.pid,
        host: typeof value.host === "string" && value.host.trim() ? value.host : "127.0.0.1",
        port: value.port,
        startedAt: value.startedAt,
        cwd: value.cwd,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function writePidRecord(pidFilePath: string, record: GatewayPidRecord): void {
  const filePath = resolve(pidFilePath);
  mkdirSync(dirname(filePath), { recursive: true });

  const existing = readPidRecord(filePath);
  if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
    throw new Error(`gateway already running (pid=${existing.pid})`);
  }

  writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
}

export function removePidRecord(pidFilePath: string): void {
  const filePath = resolve(pidFilePath);
  if (!existsSync(filePath)) {
    return;
  }
  try {
    rmSync(filePath, { force: true });
  } catch {
    // best effort
  }
}
