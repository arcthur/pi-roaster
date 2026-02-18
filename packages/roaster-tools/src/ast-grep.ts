import { existsSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RoasterToolRuntime } from "./types.js";
import { runCommand } from "./utils/exec.js";
import {
  type ParallelReadConfig,
  getToolSessionId,
  readTextBatch,
  recordParallelReadTelemetry,
  resolveAdaptiveBatchSize,
  resolveParallelReadConfig,
  summarizeReadBatch,
} from "./utils/parallel-read.js";
import { textResult } from "./utils/result.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip"]);

interface AstGrepParallelReadContext {
  runtime?: RoasterToolRuntime;
  sessionId?: string;
  toolName: string;
  operation: "naive_search" | "naive_replace";
  config: ParallelReadConfig;
}

function walkFiles(baseDir: string, paths: string[] | undefined, max = 3000): string[] {
  const roots = paths && paths.length > 0 ? paths.map((path) => resolve(baseDir, path)) : [baseDir];
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= max) return;
    if (!existsSync(dir)) return;

    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }

      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(full).isFile();
        } catch {
          continue;
        }
      }
      if (isFile) out.push(full);
    }
  };

  for (const root of roots) {
    walk(root);
  }

  return out;
}

function shouldInclude(path: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return true;

  let included = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      const pattern = glob.slice(1);
      if (path.includes(pattern)) return false;
      continue;
    }
    if (path.includes(glob)) included = true;
  }

  return included;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSearchableFile(path: string, globs: string[] | undefined): boolean {
  if (!shouldInclude(path, globs)) return false;
  return !BINARY_EXTENSIONS.has(extname(path));
}

async function naiveSearch(
  cwd: string,
  pattern: string,
  scan: AstGrepParallelReadContext,
  paths?: string[],
  globs?: string[],
): Promise<string> {
  const searchLimit = 200;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    regex = new RegExp(escapeRegExp(pattern), "g");
  }

  const startedAt = Date.now();
  const files = walkFiles(cwd, paths).filter((file) => isSearchableFile(file, globs));
  let scannedFiles = 0;
  let loadedFiles = 0;
  let failedFiles = 0;
  let batches = 0;
  const matches: string[] = [];

  const emitTelemetry = () => {
    recordParallelReadTelemetry(scan.runtime, scan.sessionId, {
      toolName: scan.toolName,
      operation: scan.operation,
      batchSize: scan.config.batchSize,
      mode: scan.config.mode,
      reason: scan.config.reason,
      scannedFiles,
      loadedFiles,
      failedFiles,
      batches,
      durationMs: Date.now() - startedAt,
    });
  };

  const scanBatch = async (batch: string[]): Promise<void> => {
    if (batch.length === 0) return;
    const loaded = await readTextBatch(batch);
    const summary = summarizeReadBatch(loaded);
    scannedFiles += summary.scannedFiles;
    loadedFiles += summary.loadedFiles;
    failedFiles += summary.failedFiles;
    batches += 1;

    for (const item of loaded) {
      if (item.content === null) continue;
      const fileRegex = new RegExp(regex.source, regex.flags);
      const lines = item.content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (fileRegex.test(line)) {
          matches.push(`${item.file}:${i + 1}: ${line.trim()}`);
        }
        fileRegex.lastIndex = 0;
        if (matches.length >= searchLimit) break;
      }
      if (matches.length >= searchLimit) break;
    }
  };

  let cursor = 0;

  // Warm up with a single file first to avoid eager multi-file reads when the
  // match cap is hit immediately.
  if (files.length > 0) {
    await scanBatch([files[0]!]);
    cursor = 1;
  }

  while (cursor < files.length && matches.length < searchLimit) {
    const remaining = searchLimit - matches.length;
    const batchSize = resolveAdaptiveBatchSize(scan.config.batchSize, remaining);
    const batch = files.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    await scanBatch(batch);
  }

  emitTelemetry();
  return matches.length > 0 ? matches.join("\n") : "No matches found";
}

async function naiveReplace(
  cwd: string,
  pattern: string,
  rewrite: string,
  scan: AstGrepParallelReadContext,
  paths?: string[],
  globs?: string[],
  dryRun = true,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    regex = new RegExp(escapeRegExp(pattern), "g");
  }

  const startedAt = Date.now();
  const files = walkFiles(cwd, paths).filter((file) => isSearchableFile(file, globs));
  let scannedFiles = 0;
  let loadedFiles = 0;
  let failedFiles = 0;
  let batches = 0;
  const updates: string[] = [];

  for (let cursor = 0; cursor < files.length; cursor += scan.config.batchSize) {
    const batch = files.slice(cursor, cursor + scan.config.batchSize);
    const loaded = await readTextBatch(batch);
    const summary = summarizeReadBatch(loaded);
    scannedFiles += summary.scannedFiles;
    loadedFiles += summary.loadedFiles;
    failedFiles += summary.failedFiles;
    batches += 1;

    for (const item of loaded) {
      if (item.content === null) continue;
      const matchRegex = new RegExp(regex.source, regex.flags);
      const matches = item.content.match(matchRegex);
      if (!matches || matches.length === 0) continue;

      const replaceRegex = new RegExp(regex.source, regex.flags);
      const next = item.content.replace(replaceRegex, rewrite);
      updates.push(`${item.file} (${matches.length} replacements)`);
      if (!dryRun) {
        await writeFile(item.file, next, "utf8");
      }
    }
  }

  const emitTelemetry = () => {
    recordParallelReadTelemetry(scan.runtime, scan.sessionId, {
      toolName: scan.toolName,
      operation: scan.operation,
      batchSize: scan.config.batchSize,
      mode: scan.config.mode,
      reason: scan.config.reason,
      scannedFiles,
      loadedFiles,
      failedFiles,
      batches,
      durationMs: Date.now() - startedAt,
    });
  };

  if (updates.length === 0) {
    emitTelemetry();
    return "No matches found";
  }

  emitTelemetry();

  return dryRun
    ? `Dry run only. Planned updates:\n${updates.join("\n")}`
    : `Applied updates:\n${updates.join("\n")}`;
}

export function createAstGrepTools(
  options?: { runtime?: RoasterToolRuntime },
): ToolDefinition<any>[] {
  const astGrepSearch: ToolDefinition<any> = {
    name: "ast_grep_search",
    label: "AST Grep Search",
    description: "Search code patterns via ast-grep if available, fallback to regex search.",
    parameters: Type.Object({
      pattern: Type.String(),
      lang: Type.String(),
      paths: Type.Optional(Type.Array(Type.String())),
      globs: Type.Optional(Type.Array(Type.String())),
      context: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const sg = await runCommand(
          "sg",
          ["scan", "-p", params.pattern, "--lang", params.lang, ...(params.paths ?? ["."])],
          {
            cwd: ctx.cwd,
            timeoutMs: 120000,
          },
        );

        const combined = `${sg.stdout}\n${sg.stderr}`.trim();
        return textResult(combined.length > 0 ? combined : "No matches found");
      } catch {
        const scan: AstGrepParallelReadContext = {
          runtime: options?.runtime,
          sessionId: getToolSessionId(ctx),
          toolName: "ast_grep_search",
          operation: "naive_search",
          config: resolveParallelReadConfig(options?.runtime),
        };
        return textResult(await naiveSearch(ctx.cwd, params.pattern, scan, params.paths, params.globs), {
          fallback: "regex",
        });
      }
    },
  };

  const astGrepReplace: ToolDefinition<any> = {
    name: "ast_grep_replace",
    label: "AST Grep Replace",
    description: "Replace code patterns via ast-grep if available, fallback to regex replacement.",
    parameters: Type.Object({
      pattern: Type.String(),
      rewrite: Type.String(),
      lang: Type.String(),
      paths: Type.Optional(Type.Array(Type.String())),
      globs: Type.Optional(Type.Array(Type.String())),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dryRun = params.dryRun !== false;
      try {
        const args = [
          "scan",
          "-p",
          params.pattern,
          "--rewrite",
          params.rewrite,
          "--lang",
          params.lang,
          ...(dryRun ? [] : ["--update-all"]),
          ...(params.paths ?? ["."]),
        ];
        const sg = await runCommand("sg", args, {
          cwd: ctx.cwd,
          timeoutMs: 120000,
        });
        const combined = `${sg.stdout}\n${sg.stderr}`.trim();
        return textResult(combined.length > 0 ? combined : "No matches found");
      } catch {
        const scan: AstGrepParallelReadContext = {
          runtime: options?.runtime,
          sessionId: getToolSessionId(ctx),
          toolName: "ast_grep_replace",
          operation: "naive_replace",
          config: resolveParallelReadConfig(options?.runtime),
        };
        return textResult(
          await naiveReplace(
            ctx.cwd,
            params.pattern,
            params.rewrite,
            scan,
            params.paths,
            params.globs,
            dryRun,
          ),
          {
            fallback: "regex",
          },
        );
      }
    },
  };

  return [astGrepSearch, astGrepReplace];
}
