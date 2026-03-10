import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { BrewvaRuntime, ContextPacketProfile, EvidenceRef } from "@brewva/brewva-runtime";
import {
  buildWorkspaceArtifactEvidenceRef,
  submitContextPacketProposal,
  type SubmittedProposal,
} from "./proposals.js";

export type CognitionArtifactLane = "reference" | "summaries";
export const COGNITION_ARTIFACT_EXTENSIONS = ["md", "txt", "json"] as const;
export type CognitionArtifactExtension = (typeof COGNITION_ARTIFACT_EXTENSIONS)[number];

type ContextPacketRuntime = Pick<BrewvaRuntime, "proposals" | "workspaceRoot">;

export interface CognitionArtifactRecord {
  lane: CognitionArtifactLane;
  fileName: string;
  absolutePath: string;
  relativePath: string;
  artifactRef: string;
  createdAt: number;
}

export interface StatusSummaryField {
  key: string;
  value: string | string[] | null | undefined;
}

export interface ParsedStatusSummaryPacket {
  profile: string | null;
  summaryKind: string | null;
  status: string | null;
  fields: Record<string, string>;
}

export interface CognitionArtifactSelection {
  artifact: CognitionArtifactRecord;
  content: string;
  score: number;
  matchedTerms: string[];
}

// Cognition artifacts live outside the kernel, so their persistence should not
// block the runtime event loop while proposals are being admitted.

function normalizeLocatorPath(path: string): string {
  return path.split(sep).join("/");
}

function normalizeNameSegment(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "artifact";
}

function normalizeSummaryValue(value: StatusSummaryField["value"]): string {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized.join("; ") : "none";
  }
  if (typeof value !== "string") {
    return "none";
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "none";
}

function normalizeDisplayLabel(value: string, fallback: string): string {
  const compact = value
    .trim()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  return compact
    .split(" ")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
}

function isSupportedCognitionArtifactExtension(value: string): value is CognitionArtifactExtension {
  return COGNITION_ARTIFACT_EXTENSIONS.includes(value as CognitionArtifactExtension);
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return (
    value instanceof Error &&
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code === code
  );
}

function parseCognitionArtifactFileName(fileName: string): {
  createdAt: number;
  stem: string;
  suffix: number;
} {
  const match = /^(\d+)-(.+?)(?:-(\d+))?\.(?:md|txt|json)$/u.exec(fileName);
  if (!match) {
    return {
      createdAt: 0,
      stem: fileName,
      suffix: 0,
    };
  }
  return {
    createdAt: Number.parseInt(match[1] ?? "", 10) || 0,
    stem: match[2] ?? fileName,
    suffix: Number.parseInt(match[3] ?? "0", 10) || 0,
  };
}

function compareCognitionArtifactFileNames(left: string, right: string): number {
  const leftMeta = parseCognitionArtifactFileName(left);
  const rightMeta = parseCognitionArtifactFileName(right);
  if (leftMeta.createdAt !== rightMeta.createdAt) {
    return leftMeta.createdAt - rightMeta.createdAt;
  }
  const stemDiff = leftMeta.stem.localeCompare(rightMeta.stem);
  if (stemDiff !== 0) {
    return stemDiff;
  }
  if (leftMeta.suffix !== rightMeta.suffix) {
    return leftMeta.suffix - rightMeta.suffix;
  }
  return left.localeCompare(right);
}

function stripArtifactExtension(fileName: string): string {
  return fileName.replace(/\.(?:md|txt|json)$/u, "");
}

const COGNITION_SELECTION_STOP_WORDS = new Set<string>([
  "about",
  "after",
  "agent",
  "again",
  "analyze",
  "build",
  "change",
  "check",
  "code",
  "continue",
  "current",
  "debug",
  "error",
  "failure",
  "files",
  "final",
  "fix",
  "from",
  "have",
  "help",
  "into",
  "issue",
  "make",
  "need",
  "next",
  "note",
  "problem",
  "project",
  "recent",
  "review",
  "session",
  "state",
  "status",
  "summary",
  "task",
  "that",
  "there",
  "these",
  "this",
  "work",
]);

function extractSelectionTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]{3,}/g)) {
    const raw = match[0];
    if (!raw) continue;
    const normalized = raw.replace(/[-_]+/g, "");
    if (normalized.length < 4 || COGNITION_SELECTION_STOP_WORDS.has(normalized)) {
      continue;
    }
    terms.add(normalized);
  }
  return [...terms];
}

export function buildStatusSummaryPacketContent(input: {
  summaryKind: string;
  status: string;
  fields?: StatusSummaryField[];
}): string {
  const lines = [
    "[StatusSummary]",
    "profile: status_summary",
    `summary_kind: ${normalizeSummaryValue(input.summaryKind)}`,
    `status: ${normalizeSummaryValue(input.status)}`,
  ];

  for (const field of input.fields ?? []) {
    const key = field.key.trim();
    if (key.length === 0) continue;
    lines.push(`${key}: ${normalizeSummaryValue(field.value)}`);
  }

  return lines.join("\n");
}

export function parseStatusSummaryPacketContent(content: string): ParsedStatusSummaryPacket | null {
  const text = content.trim();
  if (!text.startsWith("[StatusSummary]")) {
    return null;
  }

  const fields: Record<string, string> = {};
  let profile: string | null = null;
  let summaryKind: string | null = null;
  let status: string | null = null;

  for (const line of text.split("\n").slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    fields[key] = value;
    if (key === "profile") profile = value || null;
    if (key === "summary_kind") summaryKind = value || null;
    if (key === "status") status = value || null;
  }

  return {
    profile,
    summaryKind,
    status,
    fields,
  };
}

export function resolveCognitionArtifactsDir(
  workspaceRoot: string,
  lane: CognitionArtifactLane,
): string {
  return join(workspaceRoot, ".brewva", "cognition", lane);
}

export async function ensureCognitionArtifactsDirs(workspaceRoot: string): Promise<{
  referenceDir: string;
  summariesDir: string;
}> {
  const referenceDir = resolveCognitionArtifactsDir(workspaceRoot, "reference");
  const summariesDir = resolveCognitionArtifactsDir(workspaceRoot, "summaries");
  await Promise.all([
    mkdir(referenceDir, { recursive: true }),
    mkdir(summariesDir, { recursive: true }),
  ]);
  return {
    referenceDir,
    summariesDir,
  };
}

export async function writeCognitionArtifact(input: {
  workspaceRoot: string;
  lane: CognitionArtifactLane;
  name: string;
  content: string;
  extension?: CognitionArtifactExtension;
  createdAt?: number;
}): Promise<CognitionArtifactRecord> {
  const createdAt = Math.max(0, Math.floor(input.createdAt ?? Date.now()));
  const extension = input.extension ?? "md";
  const dir = resolveCognitionArtifactsDir(input.workspaceRoot, input.lane);
  await mkdir(dir, { recursive: true });

  const fileStem = `${createdAt}-${normalizeNameSegment(input.name)}`;
  for (let collisionIndex = 0; collisionIndex < 128; collisionIndex += 1) {
    const suffix = collisionIndex === 0 ? "" : `-${collisionIndex}`;
    const fileName = `${fileStem}${suffix}.${extension}`;
    const absolutePath = join(dir, fileName);
    try {
      await writeFile(absolutePath, input.content, { encoding: "utf8", flag: "wx" });
      const relativePath = normalizeLocatorPath(relative(input.workspaceRoot, absolutePath));
      return {
        lane: input.lane,
        fileName,
        absolutePath,
        relativePath,
        artifactRef: relativePath,
        createdAt,
      };
    } catch (error) {
      if (isNodeErrorWithCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("cognition_artifact_collision_limit_exceeded");
}

export async function readCognitionArtifact(input: {
  workspaceRoot: string;
  lane: CognitionArtifactLane;
  fileName: string;
}): Promise<string> {
  return readFile(
    join(resolveCognitionArtifactsDir(input.workspaceRoot, input.lane), input.fileName),
    "utf8",
  );
}

export async function listCognitionArtifacts(
  workspaceRoot: string,
  lane: CognitionArtifactLane,
): Promise<CognitionArtifactRecord[]> {
  const dir = resolveCognitionArtifactsDir(workspaceRoot, lane);
  try {
    return (await readdir(dir))
      .filter((entry) => {
        const extension = entry.split(".").at(-1);
        return typeof extension === "string" && isSupportedCognitionArtifactExtension(extension);
      })
      .toSorted(compareCognitionArtifactFileNames)
      .map((fileName) => {
        const absolutePath = join(dir, fileName);
        const relativePath = normalizeLocatorPath(relative(workspaceRoot, absolutePath));
        const createdAt = Number.parseInt(fileName.split("-")[0] ?? "", 10);
        return {
          lane,
          fileName,
          absolutePath,
          relativePath,
          artifactRef: relativePath,
          createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        };
      });
  } catch {
    return [];
  }
}

export async function deleteCognitionArtifact(artifact: CognitionArtifactRecord): Promise<void> {
  await unlink(artifact.absolutePath);
}

export async function submitExistingCognitionArtifactContextPacket(input: {
  runtime: ContextPacketRuntime;
  sessionId: string;
  issuer: string;
  artifact: CognitionArtifactRecord;
  label?: string;
  subject?: string;
  scopeId?: string;
  packetKey?: string;
  expiresAt?: number;
  evidenceRefs?: EvidenceRef[];
  profile?: ContextPacketProfile;
  content?: string;
}): Promise<SubmittedProposal<"context_packet">> {
  const content =
    typeof input.content === "string"
      ? input.content
      : await readFile(input.artifact.absolutePath, "utf8");
  return submitContextPacketProposal({
    runtime: input.runtime,
    sessionId: input.sessionId,
    issuer: input.issuer,
    subject: input.subject ?? input.label ?? stripArtifactExtension(input.artifact.fileName),
    label:
      input.label ??
      normalizeDisplayLabel(stripArtifactExtension(input.artifact.fileName), "Cognition Artifact"),
    content,
    scopeId: input.scopeId,
    packetKey:
      input.packetKey ??
      `${input.artifact.lane}:${stripArtifactExtension(input.artifact.fileName)}`,
    createdAt: input.artifact.createdAt,
    expiresAt: input.expiresAt,
    profile: input.profile,
    evidenceRefs: [
      ...(input.evidenceRefs ?? []),
      buildWorkspaceArtifactEvidenceRef({
        id: `${input.sessionId}:cognition:${input.artifact.lane}:${input.artifact.fileName}`,
        locator: input.artifact.artifactRef,
        createdAt: input.artifact.createdAt,
      }),
    ],
  });
}

export async function selectCognitionArtifactsForPrompt(input: {
  workspaceRoot: string;
  lane: CognitionArtifactLane;
  prompt: string;
  maxArtifacts?: number;
  scanLimit?: number;
}): Promise<CognitionArtifactSelection[]> {
  const terms = extractSelectionTerms(input.prompt);
  if (terms.length === 0) {
    return [];
  }

  const artifacts = (await listCognitionArtifacts(input.workspaceRoot, input.lane))
    .toReversed()
    .slice(0, Math.max(1, input.scanLimit ?? 24));
  const selected: CognitionArtifactSelection[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    const content = await readFile(artifact.absolutePath, "utf8");
    const haystack = `${artifact.fileName}\n${content}`.toLowerCase().replace(/[-_]+/g, "");
    const matchedTerms = terms.filter((term) => haystack.includes(term));
    if (matchedTerms.length === 0) continue;
    const recencyBonus = Math.max(0, artifacts.length - index);
    selected.push({
      artifact,
      content,
      matchedTerms,
      score: matchedTerms.length * 10 + recencyBonus,
    });
  }

  return selected
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.artifact.createdAt - left.artifact.createdAt;
    })
    .slice(0, Math.max(1, input.maxArtifacts ?? 2));
}

export async function submitCognitionContextPacket(input: {
  runtime: ContextPacketRuntime;
  sessionId: string;
  issuer: string;
  lane: CognitionArtifactLane;
  name: string;
  label: string;
  content: string;
  subject?: string;
  scopeId?: string;
  packetKey?: string;
  extension?: CognitionArtifactExtension;
  createdAt?: number;
  expiresAt?: number;
  evidenceRefs?: EvidenceRef[];
  profile?: ContextPacketProfile;
}): Promise<
  SubmittedProposal<"context_packet"> & {
    artifact?: CognitionArtifactRecord;
  }
> {
  const artifact = await writeCognitionArtifact({
    workspaceRoot: input.runtime.workspaceRoot,
    lane: input.lane,
    name: input.name,
    content: input.content,
    extension: input.extension,
    createdAt: input.createdAt,
  });
  const submitted = submitContextPacketProposal({
    runtime: input.runtime,
    sessionId: input.sessionId,
    issuer: input.issuer,
    subject: input.subject ?? input.label,
    label: input.label,
    content: input.content,
    scopeId: input.scopeId,
    packetKey: input.packetKey ?? `${input.lane}:${normalizeNameSegment(input.name)}`,
    createdAt: artifact.createdAt,
    expiresAt: input.expiresAt,
    profile: input.profile,
    evidenceRefs: [
      ...(input.evidenceRefs ?? []),
      buildWorkspaceArtifactEvidenceRef({
        id: `${input.sessionId}:cognition:${input.lane}:${artifact.fileName}`,
        locator: artifact.artifactRef,
        createdAt: artifact.createdAt,
      }),
    ],
  });
  if (submitted.receipt.decision !== "accept") {
    try {
      await deleteCognitionArtifact(artifact);
    } catch (error) {
      throw new Error(
        `Failed to prune cognition artifact after ${submitted.receipt.decision}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          cause: error,
        },
      );
    }
    return submitted;
  }
  return {
    ...submitted,
    artifact,
  };
}

export async function submitStatusSummaryContextPacket(input: {
  runtime: ContextPacketRuntime;
  sessionId: string;
  issuer: string;
  name: string;
  label: string;
  summaryKind: string;
  status: string;
  fields?: StatusSummaryField[];
  subject?: string;
  scopeId?: string;
  packetKey?: string;
  extension?: CognitionArtifactExtension;
  createdAt?: number;
  expiresAt?: number;
  evidenceRefs?: EvidenceRef[];
}): Promise<
  SubmittedProposal<"context_packet"> & {
    artifact?: CognitionArtifactRecord;
  }
> {
  return submitCognitionContextPacket({
    runtime: input.runtime,
    sessionId: input.sessionId,
    issuer: input.issuer,
    lane: "summaries",
    name: input.name,
    label: input.label,
    subject: input.subject,
    content: buildStatusSummaryPacketContent({
      summaryKind: input.summaryKind,
      status: input.status,
      fields: input.fields,
    }),
    scopeId: input.scopeId,
    packetKey: input.packetKey,
    extension: input.extension,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    evidenceRefs: input.evidenceRefs,
    profile: "status_summary",
  });
}
