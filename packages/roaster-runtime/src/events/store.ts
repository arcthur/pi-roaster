import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeJsonRecord } from "../utils/json.js";
import type { RoasterConfig, RoasterEventQuery, RoasterEventRecord } from "../types.js";
import { ensureDir } from "../utils/fs.js";

type EventAppendInput = {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
  timestamp?: number;
};

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function parseLines(path: string): RoasterEventRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const records: RoasterEventRecord[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as RoasterEventRecord;
      if (value && typeof value.id === "string" && typeof value.type === "string") {
        records.push(value);
      }
    } catch {
      continue;
    }
  }
  return records;
}

export class RoasterEventStore {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly fileHasContent = new Map<string, boolean>();

  constructor(config: RoasterConfig["infrastructure"]["events"], cwd: string) {
    this.enabled = config.enabled;
    this.dir = resolve(cwd, config.dir);
    if (this.enabled) {
      ensureDir(this.dir);
    }
  }

  append(input: EventAppendInput): RoasterEventRecord | undefined {
    if (!this.enabled) return undefined;

    const timestamp = input.timestamp ?? Date.now();
    const id = `evt_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
    const row: RoasterEventRecord = {
      id,
      sessionId: input.sessionId,
      type: input.type,
      timestamp,
      turn: input.turn,
      payload: normalizeJsonRecord(input.payload),
    };

    const filePath = this.filePathForSession(row.sessionId);
    const prefix = this.hasContent(filePath) ? "\n" : "";
    writeFileSync(filePath, `${prefix}${JSON.stringify(row)}`, { flag: "a" });
    this.fileHasContent.set(filePath, true);
    return row;
  }

  list(sessionId: string, query: RoasterEventQuery = {}): RoasterEventRecord[] {
    const rows = parseLines(this.filePathForSession(sessionId));
    const filtered = query.type ? rows.filter((row) => row.type === query.type) : rows;
    if (query.last && query.last > 0) {
      return filtered.slice(-query.last);
    }
    return filtered;
  }

  latest(sessionId: string): RoasterEventRecord | undefined {
    return this.list(sessionId, { last: 1 })[0];
  }

  listSessionIds(): string[] {
    if (!this.enabled) return [];
    if (!existsSync(this.dir)) return [];

    const rows: Array<{ sessionId: string; mtimeMs: number }> = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = resolve(this.dir, entry.name);
      try {
        const stat = statSync(filePath);
        if (stat.size <= 0) continue;
        rows.push({
          sessionId: entry.name.slice(0, -".jsonl".length),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }

    rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return rows.map((row) => row.sessionId);
  }

  private filePathForSession(sessionId: string): string {
    return resolve(this.dir, `${sanitizeSessionId(sessionId)}.jsonl`);
  }

  private hasContent(filePath: string): boolean {
    const cached = this.fileHasContent.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    let hasData = false;
    if (existsSync(filePath)) {
      try {
        hasData = statSync(filePath).size > 0;
      } catch {
        hasData = false;
      }
    }
    this.fileHasContent.set(filePath, hasData);
    return hasData;
  }
}
