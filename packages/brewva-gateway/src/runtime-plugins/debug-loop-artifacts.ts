import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const SESSION_ARTIFACT_ROOT = ".orchestrator/artifacts/sessions";

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolveSessionArtifactDir(workspaceRoot: string, sessionId: string): string {
  return resolve(workspaceRoot, SESSION_ARTIFACT_ROOT, `sess_${encodeSessionId(sessionId)}`);
}

export interface PersistSessionJsonArtifactInput<T> {
  workspaceRoot: string;
  sessionId: string;
  fileName: string;
  data: T;
}

export interface PersistSessionJsonArtifactResult {
  absolutePath: string;
  artifactRef?: string;
  ok: boolean;
  error?: string;
}

export function persistSessionJsonArtifact<T>(
  input: PersistSessionJsonArtifactInput<T>,
): PersistSessionJsonArtifactResult {
  const artifactDir = resolveSessionArtifactDir(input.workspaceRoot, input.sessionId);
  const absolutePath = resolve(artifactDir, input.fileName);
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(absolutePath, `${JSON.stringify(input.data, null, 2)}\n`, "utf8");
    return {
      ok: true,
      artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
      absolutePath,
    };
  } catch (error) {
    return {
      ok: false,
      absolutePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readSessionJsonArtifact<T>(input: {
  workspaceRoot: string;
  sessionId: string;
  fileName: string;
}): T | null {
  try {
    const absolutePath = resolve(
      resolveSessionArtifactDir(input.workspaceRoot, input.sessionId),
      input.fileName,
    );
    return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
  } catch {
    return null;
  }
}
