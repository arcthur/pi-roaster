import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { RoasterConfig, RuntimeSessionSnapshot } from "../types.js";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

export class SessionSnapshotStore {
  private readonly enabled: boolean;
  private readonly dir: string;

  constructor(config: RoasterConfig["infrastructure"]["interruptRecovery"], cwd: string) {
    this.enabled = config.enabled;
    this.dir = resolve(cwd, config.snapshotsDir);
    if (this.enabled) {
      ensureDir(this.dir);
    }
  }

  load(sessionId: string): RuntimeSessionSnapshot | undefined {
    if (!this.enabled) return undefined;
    const filePath = this.filePathForSession(sessionId);
    if (!existsSync(filePath)) return undefined;
    const parsed = this.readSnapshotFile(filePath);
    if (!parsed || parsed.sessionId !== sessionId) {
      return undefined;
    }
    return parsed;
  }

  latestInterrupted(): RuntimeSessionSnapshot | undefined {
    if (!this.enabled) return undefined;
    if (!existsSync(this.dir)) return undefined;

    const snapshots: RuntimeSessionSnapshot[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = resolve(this.dir, entry.name);
      const parsed = this.readSnapshotFile(filePath);
      if (!parsed || !parsed.interrupted) continue;
      snapshots.push(parsed);
    }

    snapshots.sort((left, right) => right.createdAt - left.createdAt);
    return snapshots[0];
  }

  listSnapshots(): RuntimeSessionSnapshot[] {
    if (!this.enabled) return [];
    if (!existsSync(this.dir)) return [];

    const rows: RuntimeSessionSnapshot[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = this.readSnapshotFile(resolve(this.dir, entry.name));
      if (!parsed) continue;
      rows.push(parsed);
    }
    rows.sort((left, right) => right.createdAt - left.createdAt);
    return rows;
  }

  save(snapshot: RuntimeSessionSnapshot): void {
    if (!this.enabled) return;
    const filePath = this.filePathForSession(snapshot.sessionId);
    writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2));
  }

  remove(sessionId: string): void {
    if (!this.enabled) return;
    const filePath = this.filePathForSession(sessionId);
    if (!existsSync(filePath)) return;
    rmSync(filePath, { force: true });
  }

  private readSnapshotFile(filePath: string): RuntimeSessionSnapshot | undefined {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as RuntimeSessionSnapshot;
      if (!parsed || parsed.version !== 1 || typeof parsed.sessionId !== "string") {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private filePathForSession(sessionId: string): string {
    return resolve(this.dir, `${sanitizeSessionId(sessionId)}.json`);
  }
}
