import { test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type RuntimeEventLike = {
  type?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export type BrewvaEventBundle = {
  schema: "brewva.stream.v1";
  type: "brewva_event_bundle";
  sessionId: string;
  events: RuntimeEventLike[];
  costSummary?: {
    totalTokens?: number;
    totalCostUsd?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export const repoRoot = resolve(import.meta.dir, "../..");
export const runLive: typeof test =
  process.env.BREWVA_E2E_LIVE === "1" ? test : test.skip;
export const keepWorkspace = process.env.BREWVA_E2E_KEEP_WORKSPACE === "1";

export function createWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-e2e-${prefix}-`));
}

export function cleanupWorkspace(workspace: string): void {
  if (keepWorkspace) return;
  rmSync(workspace, { recursive: true, force: true });
}

export function writeMinimalConfig(
  workspace: string,
  overrides?: Record<string, unknown>,
): void {
  const configDir = join(workspace, ".brewva");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "brewva.json"),
    JSON.stringify(overrides ?? {}, null, 2),
    "utf8",
  );
}

export function latestEventFile(workspace: string): string | undefined {
  const eventsDir = join(workspace, ".orchestrator", "events");
  if (!existsSync(eventsDir)) return undefined;
  const candidates = readdirSync(eventsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = join(eventsDir, name);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file;
}

export function latestStateSnapshot(workspace: string): string | undefined {
  const stateDir = join(workspace, ".orchestrator", "state");
  if (!existsSync(stateDir)) return undefined;
  const candidates = readdirSync(stateDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = join(stateDir, name);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file;
}

export function parseEventFile(
  filePath: string,
  options?: { strict?: boolean },
): RuntimeEventLike[] {
  const invalidLines: string[] = [];

  const parsed = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const decoded = JSON.parse(line);
        if (isRecord(decoded)) {
          return decoded as RuntimeEventLike;
        }
        invalidLines.push(line);
        return {};
      } catch {
        invalidLines.push(line);
        return {};
      }
    });

  if (options?.strict && invalidLines.length > 0) {
    const sample = invalidLines.slice(0, 3).join("\n");
    throw new Error(
      [
        `Expected structured event JSON lines only, but found ${invalidLines.length} invalid line(s).`,
        "Sample invalid lines:",
        sample,
      ].join("\n"),
    );
  }

  return parsed;
}

export function parseJsonLines(
  stdout: string,
  options?: { strict?: boolean },
): unknown[] {
  const invalidLines: string[] = [];

  const parsed = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        invalidLines.push(line);
        return undefined;
      }
    })
    .filter((line): line is unknown => line !== undefined);

  if (options?.strict && invalidLines.length > 0) {
    const sample = invalidLines.slice(0, 3).join("\n");
    throw new Error(
      [
        `Expected JSON lines only, but found ${invalidLines.length} invalid line(s).`,
        "Sample invalid lines:",
        sample,
      ].join("\n"),
    );
  }

  return parsed;
}

export function findFinalBundle(lines: unknown[]): BrewvaEventBundle | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = lines[i];
    if (!isRecord(row)) continue;
    if (row.schema !== "brewva.stream.v1") continue;
    if (row.type !== "brewva_event_bundle") continue;
    if (typeof row.sessionId !== "string") continue;
    if (!Array.isArray(row.events)) continue;

    return row as BrewvaEventBundle;
  }
  return undefined;
}

export function countEventType(
  events: Array<{ type?: string }>,
  eventType: string,
): number {
  return events.filter((event) => event.type === eventType).length;
}

export function firstIndexOf(
  events: Array<{ type?: string }>,
  eventType: string,
): number {
  return events.findIndex((event) => event.type === eventType);
}

export function runCliSync(
  workspace: string,
  args: string[],
  options?: {
    input?: string;
    timeoutMs?: number;
    maxBufferBytes?: number;
    env?: NodeJS.ProcessEnv;
  },
): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", "start", "--cwd", workspace, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options?.input,
    timeout: options?.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: options?.maxBufferBytes ?? 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(options?.env ?? {}),
    },
  });
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertCliSuccess(
  result: SpawnSyncReturns<string>,
  label: string,
): void {
  if (result.status === 0 && result.error === undefined) return;
  const lines = [
    `[${label}] CLI exited with status ${result.status ?? "null"}`,
    `[${label}] error: ${result.error ? String(result.error) : "none"}`,
    `[${label}] stdout:`,
    (result.stdout ?? "").trim().slice(0, 2000),
    `[${label}] stderr:`,
    (result.stderr ?? "").trim().slice(0, 2000),
  ];
  throw new Error(lines.join("\n"));
}
