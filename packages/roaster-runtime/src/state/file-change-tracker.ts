import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { PatchFileAction, PatchSet, RollbackResult } from "../types.js";
import { isMutationTool } from "../verification/classifier.js";
import { sha256 } from "../utils/hash.js";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";

const EXTRA_MUTATION_TOOLS = new Set(["multi_edit"]);
const CANDIDATE_PATH_KEY = /(path|file)/i;
const MAX_HISTORY = 64;
const PATCH_HISTORY_FILE = "patchsets.json";

interface TrackedFileState {
  absolutePath: string;
  relativePath: string;
  beforeExists: boolean;
  beforeHash?: string;
  beforeSnapshotPath?: string;
}

interface PendingMutation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  trackedFiles: TrackedFileState[];
  startedAt: number;
}

interface AppliedMutation {
  patchSet: PatchSet;
  toolName: string;
  appliedAt: number;
  changes: Array<
    TrackedFileState & {
      action: PatchFileAction;
      afterHash?: string;
    }
  >;
}

interface PersistedChange {
  path: string;
  action: PatchFileAction;
  beforeExists: boolean;
  beforeHash?: string;
  afterHash?: string;
  beforeSnapshotFile?: string;
}

interface PersistedPatchSet {
  id: string;
  createdAt: number;
  summary?: string;
  toolName: string;
  appliedAt: number;
  changes: PersistedChange[];
}

interface PersistedPatchHistory {
  version: 1;
  sessionId: string;
  updatedAt: number;
  patchSets: PersistedPatchSet[];
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function shouldTrackMutationTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return false;
  return isMutationTool(normalized) || EXTRA_MUTATION_TOOLS.has(normalized);
}

function collectPathCandidates(value: unknown, keyHint?: string, output: string[] = []): string[] {
  if (typeof value === "string") {
    if (keyHint && CANDIDATE_PATH_KEY.test(keyHint)) {
      output.push(value);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, keyHint, output);
    }
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectPathCandidates(child, key, output);
  }
  return output;
}

function resolveFilePath(cwd: string, candidate: string): { absolutePath: string; relativePath: string } | undefined {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;

  const absolutePath = resolve(cwd, trimmed);
  const rel = relative(cwd, absolutePath);
  if (!rel || rel === "." || rel.startsWith("..")) {
    return undefined;
  }
  return {
    absolutePath,
    relativePath: normalizeRelativePath(rel),
  };
}

function buildPatchSetId(now: number): string {
  return `patch_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function snapshotFileName(path: string): string {
  return basename(path);
}

export class FileChangeTracker {
  private readonly cwd: string;
  private readonly snapshotsDir: string;
  private readonly pendingBySession = new Map<string, Map<string, PendingMutation>>();
  private readonly historyBySession = new Map<string, AppliedMutation[]>();
  private readonly loadedSessions = new Set<string>();

  constructor(cwd: string, snapshotsDir = ".orchestrator/snapshots") {
    this.cwd = resolve(cwd);
    this.snapshotsDir = resolve(this.cwd, snapshotsDir);
    ensureDir(this.snapshotsDir);
  }

  captureBeforeToolCall(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): { trackedFiles: string[] } {
    if (!shouldTrackMutationTool(input.toolName)) {
      return { trackedFiles: [] };
    }
    this.ensureHistoryLoaded(input.sessionId);

    const pendingForSession = this.getOrCreatePending(input.sessionId);
    if (pendingForSession.has(input.toolCallId)) {
      const existing = pendingForSession.get(input.toolCallId);
      return { trackedFiles: existing?.trackedFiles.map((item) => item.relativePath) ?? [] };
    }

    const trackedByPath = new Map<string, TrackedFileState>();
    const candidates = collectPathCandidates(input.args ?? {});
    for (const candidate of candidates) {
      const resolvedPath = resolveFilePath(this.cwd, candidate);
      if (!resolvedPath) continue;
      if (trackedByPath.has(resolvedPath.absolutePath)) continue;
      const snapshot = this.captureFileSnapshot(input.sessionId, resolvedPath.absolutePath, resolvedPath.relativePath);
      trackedByPath.set(resolvedPath.absolutePath, snapshot);
    }

    const trackedFiles = [...trackedByPath.values()];
    pendingForSession.set(input.toolCallId, {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      trackedFiles,
      startedAt: Date.now(),
    });

    return { trackedFiles: trackedFiles.map((item) => item.relativePath) };
  }

  completeToolCall(input: {
    sessionId: string;
    toolCallId: string;
    success: boolean;
  }): PatchSet | undefined {
    this.ensureHistoryLoaded(input.sessionId);
    const pendingForSession = this.pendingBySession.get(input.sessionId);
    const pending = pendingForSession?.get(input.toolCallId);
    if (!pending) return undefined;

    pendingForSession?.delete(input.toolCallId);
    if (!input.success) return undefined;

    const changedFiles: AppliedMutation["changes"] = [];
    for (const tracked of pending.trackedFiles) {
      const afterExists = existsSync(tracked.absolutePath);
      const afterHash = afterExists ? sha256(readFileSync(tracked.absolutePath)) : undefined;
      const action = this.resolveAction({
        beforeExists: tracked.beforeExists,
        afterExists,
        beforeHash: tracked.beforeHash,
        afterHash,
      });
      if (!action) continue;
      changedFiles.push({
        ...tracked,
        action,
        afterHash,
      });
    }

    if (changedFiles.length === 0) {
      return undefined;
    }

    const now = Date.now();
    const patchSet: PatchSet = {
      id: buildPatchSetId(now),
      createdAt: now,
      summary: `${pending.toolName}: ${changedFiles.length} file(s)`,
      changes: changedFiles.map((item) => ({
        path: item.relativePath,
        action: item.action,
        beforeHash: item.beforeHash,
        afterHash: item.afterHash,
      })),
    };

    const history = this.getOrCreateHistory(input.sessionId);
    history.push({
      patchSet,
      toolName: pending.toolName,
      appliedAt: now,
      changes: changedFiles,
    });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    this.persistHistory(input.sessionId);
    return patchSet;
  }

  rollbackLast(sessionId: string): RollbackResult {
    this.ensureHistoryLoaded(sessionId);
    const history = this.historyBySession.get(sessionId);
    const latest = history?.at(-1);
    if (!latest) {
      return {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "no_patchset",
      };
    }

    const restoredPaths: string[] = [];
    const failedPaths: string[] = [];
    for (const change of [...latest.changes].reverse()) {
      try {
        if (change.beforeExists) {
          if (!change.beforeSnapshotPath || !existsSync(change.beforeSnapshotPath)) {
            throw new Error(`Missing snapshot for ${change.relativePath}`);
          }
          writeFileAtomic(change.absolutePath, readFileSync(change.beforeSnapshotPath));
        } else if (existsSync(change.absolutePath)) {
          rmSync(change.absolutePath, { force: true });
        }
        restoredPaths.push(change.relativePath);
      } catch {
        failedPaths.push(change.relativePath);
      }
    }

    if (failedPaths.length > 0) {
      return {
        ok: false,
        patchSetId: latest.patchSet.id,
        restoredPaths,
        failedPaths,
        reason: "restore_failed",
      };
    }

    history?.pop();
    this.persistHistory(sessionId);
    return {
      ok: true,
      patchSetId: latest.patchSet.id,
      restoredPaths,
      failedPaths: [],
    };
  }

  hasHistory(sessionId: string): boolean {
    this.ensureHistoryLoaded(sessionId);
    return (this.historyBySession.get(sessionId)?.length ?? 0) > 0;
  }

  recentFiles(sessionId: string, limit = 3): string[] {
    const max = Math.max(0, Math.floor(limit));
    if (max <= 0) return [];

    this.ensureHistoryLoaded(sessionId);
    const history = this.historyBySession.get(sessionId) ?? [];
    if (history.length === 0) return [];

    const selected: string[] = [];
    const seen = new Set<string>();

    for (const entry of [...history].reverse()) {
      for (const change of entry.patchSet.changes) {
        const path = change.path;
        if (!path) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        selected.push(path);
        if (selected.length >= max) return selected;
      }
    }

    return selected;
  }

  latestSessionWithHistory(): string | undefined {
    const candidates: Array<{ sessionId: string; updatedAt: number }> = [];
    if (!existsSync(this.snapshotsDir)) return undefined;

    for (const entry of readdirSync(this.snapshotsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const historyFile = resolve(this.snapshotsDir, entry.name, PATCH_HISTORY_FILE);
      if (!existsSync(historyFile)) continue;
      try {
        const parsed = JSON.parse(readFileSync(historyFile, "utf8")) as PersistedPatchHistory;
        if (!parsed || parsed.version !== 1 || typeof parsed.sessionId !== "string") continue;
        const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : statSync(historyFile).mtimeMs;
        if ((parsed.patchSets?.length ?? 0) > 0) {
          candidates.push({ sessionId: parsed.sessionId, updatedAt });
        }
      } catch {
        continue;
      }
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    return candidates[0]?.sessionId;
  }

  importSessionHistory(sourceSessionId: string, targetSessionId: string): { importedPatchSets: number } {
    if (sourceSessionId === targetSessionId) {
      return { importedPatchSets: 0 };
    }

    this.ensureHistoryLoaded(sourceSessionId);
    this.ensureHistoryLoaded(targetSessionId);

    const sourceHistory = this.historyBySession.get(sourceSessionId) ?? [];
    if (sourceHistory.length === 0) {
      return { importedPatchSets: 0 };
    }

    const sourceDir = this.sessionDir(sourceSessionId);
    const targetDir = this.sessionDir(targetSessionId);
    ensureDir(targetDir);

    const targetHistory = this.getOrCreateHistory(targetSessionId);
    const existingIds = new Set(targetHistory.map((item) => item.patchSet.id));
    const imported: AppliedMutation[] = [];

    for (const entry of sourceHistory) {
      if (existingIds.has(entry.patchSet.id)) {
        continue;
      }

      const changes = entry.changes.map((change) => {
        let beforeSnapshotPath: string | undefined;
        if (change.beforeSnapshotPath) {
          const snapshotFile = snapshotFileName(change.beforeSnapshotPath);
          const sourceSnapshotPath = resolve(sourceDir, snapshotFile);
          const fallbackSnapshotPath = change.beforeSnapshotPath;
          const selectedSourcePath = existsSync(sourceSnapshotPath)
            ? sourceSnapshotPath
            : existsSync(fallbackSnapshotPath)
              ? fallbackSnapshotPath
              : undefined;

          if (selectedSourcePath) {
            const targetSnapshotPath = resolve(targetDir, snapshotFile);
            if (!existsSync(targetSnapshotPath)) {
              writeFileAtomic(targetSnapshotPath, readFileSync(selectedSourcePath));
            }
            beforeSnapshotPath = targetSnapshotPath;
          }
        }

        return {
          ...change,
          beforeSnapshotPath,
        };
      });

      imported.push({
        patchSet: {
          ...entry.patchSet,
          changes: changes.map((change) => ({
            path: change.relativePath,
            action: change.action,
            beforeHash: change.beforeHash,
            afterHash: change.afterHash,
          })),
        },
        toolName: entry.toolName,
        appliedAt: entry.appliedAt,
        changes,
      });
    }

    if (imported.length === 0) {
      return { importedPatchSets: 0 };
    }

    const merged = [...targetHistory, ...imported].sort((left, right) => left.appliedAt - right.appliedAt);
    const trimmed = merged.slice(-MAX_HISTORY);
    this.historyBySession.set(targetSessionId, trimmed);
    this.persistHistory(targetSessionId);
    return { importedPatchSets: imported.length };
  }

  clearSession(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
    this.historyBySession.delete(sessionId);
    this.loadedSessions.delete(sessionId);
  }

  private captureFileSnapshot(sessionId: string, absolutePath: string, relativePath: string): TrackedFileState {
    const beforeExists = existsSync(absolutePath);
    if (!beforeExists) {
      return {
        absolutePath,
        relativePath,
        beforeExists: false,
      };
    }

    const content = readFileSync(absolutePath);
    const beforeHash = sha256(content);
    const sessionDir = this.sessionDir(sessionId);
    ensureDir(sessionDir);

    const snapshotId = sha256(`${relativePath}:${beforeHash}`);
    const beforeSnapshotPath = resolve(sessionDir, `${snapshotId}.snap`);
    if (!existsSync(beforeSnapshotPath)) {
      writeFileAtomic(beforeSnapshotPath, content);
    }

    return {
      absolutePath,
      relativePath,
      beforeExists: true,
      beforeHash,
      beforeSnapshotPath,
    };
  }

  private resolveAction(input: {
    beforeExists: boolean;
    afterExists: boolean;
    beforeHash?: string;
    afterHash?: string;
  }): PatchFileAction | undefined {
    if (!input.beforeExists && input.afterExists) return "add";
    if (input.beforeExists && !input.afterExists) return "delete";
    if (input.beforeExists && input.afterExists && input.beforeHash !== input.afterHash) return "modify";
    return undefined;
  }

  private getOrCreatePending(sessionId: string): Map<string, PendingMutation> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const pending = new Map<string, PendingMutation>();
    this.pendingBySession.set(sessionId, pending);
    return pending;
  }

  private getOrCreateHistory(sessionId: string): AppliedMutation[] {
    const existing = this.historyBySession.get(sessionId);
    if (existing) return existing;
    const history: AppliedMutation[] = [];
    this.historyBySession.set(sessionId, history);
    return history;
  }

  private ensureHistoryLoaded(sessionId: string): void {
    if (this.loadedSessions.has(sessionId)) {
      return;
    }
    this.loadedSessions.add(sessionId);

    const historyPath = this.historyPath(sessionId);
    if (!existsSync(historyPath)) {
      this.historyBySession.set(sessionId, []);
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(historyPath, "utf8")) as PersistedPatchHistory;
      if (!parsed || parsed.version !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.patchSets)) {
        this.historyBySession.set(sessionId, []);
        return;
      }

      const history: AppliedMutation[] = [];
      for (const entry of parsed.patchSets) {
        if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.changes)) continue;
        const changes = entry.changes.map((change) => {
          const absolutePath = resolve(this.cwd, change.path);
          const beforeSnapshotPath = change.beforeSnapshotFile
            ? resolve(this.sessionDir(sessionId), change.beforeSnapshotFile)
            : undefined;
          return {
            absolutePath,
            relativePath: normalizeRelativePath(change.path),
            beforeExists: change.beforeExists,
            beforeHash: change.beforeHash,
            beforeSnapshotPath,
            action: change.action,
            afterHash: change.afterHash,
          };
        });

        history.push({
          patchSet: {
            id: entry.id,
            createdAt: entry.createdAt,
            summary: entry.summary,
            changes: entry.changes.map((change) => ({
              path: change.path,
              action: change.action,
              beforeHash: change.beforeHash,
              afterHash: change.afterHash,
            })),
          },
          toolName: entry.toolName,
          appliedAt: entry.appliedAt,
          changes,
        });
      }
      this.historyBySession.set(sessionId, history.slice(-MAX_HISTORY));
    } catch {
      this.historyBySession.set(sessionId, []);
    }
  }

  private persistHistory(sessionId: string): void {
    const history = this.historyBySession.get(sessionId) ?? [];
    const payload: PersistedPatchHistory = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      patchSets: history.map((item) => ({
        id: item.patchSet.id,
        createdAt: item.patchSet.createdAt,
        summary: item.patchSet.summary,
        toolName: item.toolName,
        appliedAt: item.appliedAt,
        changes: item.changes.map((change) => ({
          path: change.relativePath,
          action: change.action,
          beforeExists: change.beforeExists,
          beforeHash: change.beforeHash,
          afterHash: change.afterHash,
          beforeSnapshotFile: change.beforeSnapshotPath ? snapshotFileName(change.beforeSnapshotPath) : undefined,
        })),
      })),
    };
    writeFileAtomic(this.historyPath(sessionId), JSON.stringify(payload, null, 2));
  }

  private sessionDir(sessionId: string): string {
    return resolve(this.snapshotsDir, sanitizeSessionId(sessionId));
  }

  private historyPath(sessionId: string): string {
    return resolve(this.sessionDir(sessionId), PATCH_HISTORY_FILE);
  }
}
