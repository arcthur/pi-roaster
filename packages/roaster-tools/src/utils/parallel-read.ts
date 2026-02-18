import { readFile } from "node:fs/promises";
import type { RoasterToolRuntime } from "../types.js";

const DEFAULT_PARALLEL_READ_BATCH_SIZE = 16;
const MAX_PARALLEL_READ_BATCH_SIZE = 64;
const PARALLEL_READ_MULTIPLIER = 4;

export type ParallelReadMode = "parallel" | "sequential";
export type ParallelReadReason =
  | "runtime_unavailable"
  | "parallel_disabled"
  | "runtime_parallel_budget";

export interface ParallelReadConfig {
  batchSize: number;
  mode: ParallelReadMode;
  reason: ParallelReadReason;
}

export interface ParallelReadTelemetry {
  toolName: string;
  operation: string;
  batchSize: number;
  mode: ParallelReadMode;
  reason: ParallelReadReason;
  scannedFiles: number;
  loadedFiles: number;
  failedFiles: number;
  batches: number;
  durationMs: number;
}

export interface ReadBatchItem {
  file: string;
  content: string | null;
}

export interface ReadBatchSummary {
  scannedFiles: number;
  loadedFiles: number;
  failedFiles: number;
}

function toPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function clampBatchSize(value: number): number {
  return Math.max(1, Math.min(MAX_PARALLEL_READ_BATCH_SIZE, Math.trunc(value)));
}

export function resolveParallelReadConfig(
  runtime?: RoasterToolRuntime,
): ParallelReadConfig {
  const parallel = runtime?.config?.parallel;
  if (!parallel) {
    return {
      batchSize: DEFAULT_PARALLEL_READ_BATCH_SIZE,
      mode: "parallel",
      reason: "runtime_unavailable",
    };
  }

  if (!parallel.enabled) {
    return {
      batchSize: 1,
      mode: "sequential",
      reason: "parallel_disabled",
    };
  }

  // Use the tighter runtime parallel limit so tool-side scans respect both
  // per-turn concurrency and total parallel slot budgets.
  const budget = Math.min(
    toPositiveInteger(parallel.maxConcurrent),
    toPositiveInteger(parallel.maxTotal),
  );
  const scaled = budget * PARALLEL_READ_MULTIPLIER;
  const batchSize = clampBatchSize(scaled);

  return {
    batchSize,
    mode: batchSize > 1 ? "parallel" : "sequential",
    reason: "runtime_parallel_budget",
  };
}

export function resolveAdaptiveBatchSize(
  batchSize: number,
  remainingWork: number,
): number {
  const normalizedBatch = clampBatchSize(batchSize);
  const normalizedRemaining = toPositiveInteger(remainingWork);
  return Math.max(1, Math.min(normalizedBatch, normalizedRemaining));
}

export function summarizeReadBatch(items: ReadBatchItem[]): ReadBatchSummary {
  let loadedFiles = 0;
  let failedFiles = 0;
  for (const item of items) {
    if (item.content === null) {
      failedFiles += 1;
      continue;
    }
    loadedFiles += 1;
  }

  return {
    scannedFiles: items.length,
    loadedFiles,
    failedFiles,
  };
}

export function getToolSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
  const value = sessionManager?.getSessionId?.();
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function recordParallelReadTelemetry(
  runtime: RoasterToolRuntime | undefined,
  sessionId: string | undefined,
  telemetry: ParallelReadTelemetry,
): void {
  if (!runtime?.recordEvent) return;
  if (!sessionId) return;
  runtime.recordEvent({
    sessionId,
    type: "tool_parallel_read",
    payload: {
      toolName: telemetry.toolName,
      operation: telemetry.operation,
      batchSize: telemetry.batchSize,
      mode: telemetry.mode,
      reason: telemetry.reason,
      scannedFiles: telemetry.scannedFiles,
      loadedFiles: telemetry.loadedFiles,
      failedFiles: telemetry.failedFiles,
      batches: telemetry.batches,
      durationMs: telemetry.durationMs,
    },
  });
}

export async function readTextBatch(files: string[]): Promise<ReadBatchItem[]> {
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, content: await readFile(file, "utf8") };
      } catch {
        return { file, content: null };
      }
    }),
  );
}
