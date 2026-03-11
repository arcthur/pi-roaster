import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const DEFAULT_ARTIFACT_DIR = ".orchestrator/tool-output-artifacts";

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function sanitizeFileSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-");
  const compact = normalized.replaceAll(/-+/g, "-").replaceAll(/^-+|-+$/g, "");
  return compact || "unknown";
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export interface PersistToolOutputArtifactInput {
  workspaceRoot: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  outputText: string;
  timestamp?: number;
}

export interface PersistToolOutputArtifactResult {
  artifactRef: string;
  absolutePath: string;
  rawChars: number;
  rawBytes: number;
  sha256: string;
}

export function persistToolOutputArtifact(
  input: PersistToolOutputArtifactInput,
): PersistToolOutputArtifactResult | null {
  if (!input.outputText) return null;

  try {
    const timestamp = Number.isFinite(input.timestamp ?? NaN)
      ? Math.max(0, Math.floor(input.timestamp ?? 0))
      : Date.now();
    const sessionBucket = encodeSessionId(input.sessionId);
    const toolName = sanitizeFileSegment(input.toolName);
    const toolCallId = sanitizeFileSegment(input.toolCallId);
    const artifactDir = resolve(input.workspaceRoot, DEFAULT_ARTIFACT_DIR, sessionBucket);
    const fileName = `${timestamp}-${toolName}-${toolCallId}.txt`;
    const absolutePath = resolve(artifactDir, fileName);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(absolutePath, input.outputText, "utf8");

    const rawBytes = Buffer.byteLength(input.outputText, "utf8");
    const rawChars = input.outputText.length;
    const sha256 = createHash("sha256").update(input.outputText).digest("hex");
    const artifactRef = normalizeRelativePath(relative(input.workspaceRoot, absolutePath));

    return {
      artifactRef,
      absolutePath,
      rawChars,
      rawBytes,
      sha256,
    };
  } catch {
    return null;
  }
}
