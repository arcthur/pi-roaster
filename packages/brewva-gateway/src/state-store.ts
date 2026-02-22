import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ChildRegistryEntry {
  sessionId: string;
  pid: number;
  startedAt: number;
}

export interface GatewayStateStore {
  readToken(tokenFilePath: string): string | undefined;
  writeToken(tokenFilePath: string, token: string): void;
  readChildrenRegistry(registryPath: string): ChildRegistryEntry[];
  writeChildrenRegistry(registryPath: string, entries: ReadonlyArray<ChildRegistryEntry>): void;
  removeChildrenRegistry(registryPath: string): void;
}

function parseChildRegistryEntries(raw: unknown): ChildRegistryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: ChildRegistryEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const candidate = row as Partial<ChildRegistryEntry>;
    if (
      typeof candidate.sessionId !== "string" ||
      typeof candidate.pid !== "number" ||
      typeof candidate.startedAt !== "number"
    ) {
      continue;
    }
    if (!candidate.sessionId.trim() || candidate.pid <= 0 || candidate.startedAt <= 0) {
      continue;
    }
    entries.push({
      sessionId: candidate.sessionId,
      pid: candidate.pid,
      startedAt: candidate.startedAt,
    });
  }
  return entries;
}

export class FileGatewayStateStore implements GatewayStateStore {
  readToken(tokenFilePath: string): string | undefined {
    const filePath = resolve(tokenFilePath);
    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      const value = readFileSync(filePath, "utf8").trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  writeToken(tokenFilePath: string, token: string): void {
    const filePath = resolve(tokenFilePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  readChildrenRegistry(registryPath: string): ChildRegistryEntry[] {
    const filePath = resolve(registryPath);
    if (!existsSync(filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return parseChildRegistryEntries(parsed);
    } catch {
      return [];
    }
  }

  writeChildrenRegistry(registryPath: string, entries: ReadonlyArray<ChildRegistryEntry>): void {
    const filePath = resolve(registryPath);
    mkdirSync(dirname(filePath), { recursive: true });

    const tmpPath = `${filePath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
      renameSync(tmpPath, filePath);
    } catch (error) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // best effort
      }
      throw error;
    }
  }

  removeChildrenRegistry(registryPath: string): void {
    const filePath = resolve(registryPath);
    if (!existsSync(filePath)) {
      return;
    }
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best effort
    }
  }
}
