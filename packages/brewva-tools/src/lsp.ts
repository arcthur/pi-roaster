import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  parseTscDiagnostics,
  type TscDiagnostic,
} from "@brewva/brewva-runtime";
import type { BrewvaToolRuntime } from "./types.js";
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

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

interface LspParallelReadContext {
  runtime?: BrewvaToolRuntime;
  sessionId?: string;
  toolName: string;
  config: ParallelReadConfig;
}

function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function walkCodeFiles(rootDir: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".config") continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        walk(full);
      } else if (isFile && isCodeFile(full)) {
        out.push(full);
      }
    }
  };

  walk(rootDir);
  return out;
}

function lineAt(filePath: string, line: number): string {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  return lines[line - 1] ?? "";
}

function wordAt(filePath: string, line: number, character: number): string {
  const sourceLine = lineAt(filePath, line);
  if (!sourceLine) return "";
  const safeChar = Math.max(0, Math.min(sourceLine.length - 1, character));

  const isWord = (char: string): boolean => /[A-Za-z0-9_]/.test(char);
  let start = safeChar;
  let end = safeChar;
  while (start > 0) {
    const char = sourceLine[start - 1];
    if (!char || !isWord(char)) break;
    start -= 1;
  }
  while (end < sourceLine.length) {
    const char = sourceLine[end];
    if (!char || !isWord(char)) break;
    end += 1;
  }
  return sourceLine.slice(start, end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findDefinition(
  rootDir: string,
  symbol: string,
  scan: LspParallelReadContext,
  hintFile?: string,
  limit = 20,
): Promise<string[]> {
  const targetLimit = Math.max(1, Math.trunc(limit));
  const patterns = [
    new RegExp(`\\bfunction\\s+${escapeRegExp(symbol)}\\b`),
    new RegExp(`\\b(class|interface|type|enum)\\s+${escapeRegExp(symbol)}\\b`),
    new RegExp(`\\b(const|let|var)\\s+${escapeRegExp(symbol)}\\b`),
    new RegExp(`\\bdef\\s+${escapeRegExp(symbol)}\\b`),
  ];

  const files = walkCodeFiles(rootDir);
  const ordered = hintFile
    ? [hintFile, ...files.filter((file) => file !== hintFile)]
    : files;

  const startedAt = Date.now();
  let scannedFiles = 0;
  let loadedFiles = 0;
  let failedFiles = 0;
  let batches = 0;
  const matches: string[] = [];

  const emitTelemetry = () => {
    recordParallelReadTelemetry(scan.runtime, scan.sessionId, {
      toolName: scan.toolName,
      operation: "find_definition",
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

  const scanBatch = async (batch: string[]): Promise<boolean> => {
    if (batch.length === 0) return false;
    const loaded = await readTextBatch(batch);
    const summary = summarizeReadBatch(loaded);
    scannedFiles += summary.scannedFiles;
    loadedFiles += summary.loadedFiles;
    failedFiles += summary.failedFiles;
    batches += 1;

    for (const item of loaded) {
      if (item.content === null) continue;
      const lines = item.content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (patterns.some((pattern) => pattern.test(line))) {
          matches.push(`${item.file}:${i + 1}:0 -> ${line.trim()}`);
        }
        if (matches.length >= targetLimit) return true;
      }
    }
    return false;
  };

  let cursor = 0;

  // Warm up with the hinted file first to avoid eager multi-file reads on
  // common goto-definition paths that resolve immediately.
  if (hintFile && ordered.length > 0) {
    if (await scanBatch([ordered[0]!])) {
      emitTelemetry();
      return matches;
    }
    cursor = 1;
  }

  while (cursor < ordered.length && matches.length < targetLimit) {
    const remaining = targetLimit - matches.length;
    const batchSize = resolveAdaptiveBatchSize(scan.config.batchSize, remaining);
    const batch = ordered.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    if (await scanBatch(batch)) {
      emitTelemetry();
      return matches;
    }
  }

  emitTelemetry();
  return matches;
}

async function findReferences(
  rootDir: string,
  symbol: string,
  scan: LspParallelReadContext,
  limit = 200,
): Promise<string[]> {
  const targetLimit = Math.max(1, Math.trunc(limit));
  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const files = walkCodeFiles(rootDir);
  const startedAt = Date.now();
  let scannedFiles = 0;
  let loadedFiles = 0;
  let failedFiles = 0;
  let batches = 0;
  const matches: string[] = [];

  const emitTelemetry = () => {
    recordParallelReadTelemetry(scan.runtime, scan.sessionId, {
      toolName: scan.toolName,
      operation: "find_references",
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

  let cursor = 0;
  while (cursor < files.length && matches.length < targetLimit) {
    const remaining = targetLimit - matches.length;
    const batchSize = resolveAdaptiveBatchSize(scan.config.batchSize, remaining);
    const batch = files.slice(cursor, cursor + batchSize);
    cursor += batch.length;

    const loaded = await readTextBatch(batch);
    const summary = summarizeReadBatch(loaded);
    scannedFiles += summary.scannedFiles;
    loadedFiles += summary.loadedFiles;
    failedFiles += summary.failedFiles;
    batches += 1;

    for (const item of loaded) {
      if (item.content === null) continue;
      const lines = item.content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (pattern.test(line)) {
          matches.push(`${item.file}:${i + 1}:0 -> ${line.trim()}`);
        }
        if (matches.length >= targetLimit) {
          emitTelemetry();
          return matches;
        }
      }
    }
  }

  emitTelemetry();
  return matches;
}

function listSymbolsInFile(filePath: string, limit = 100): string[] {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const matcher =
    /\b(function|class|interface|type|enum|const|let|var|def)\s+([A-Za-z0-9_]+)/;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = line.match(matcher);
    if (!match) continue;
    const kind = match[1];
    const symbol = match[2];
    if (!kind || !symbol) continue;
    out.push(`${filePath}:${i + 1}:0 -> ${kind} ${symbol}`);
    if (out.length >= limit) break;
  }
  return out;
}

function parseSeverityLine(
  line: string,
): "error" | "warning" | "information" | "hint" {
  const lower = line.toLowerCase();
  if (lower.includes("error")) return "error";
  if (lower.includes("warning")) return "warning";
  if (lower.includes("hint")) return "hint";
  return "information";
}

type DiagnosticsRun = {
  text: string;
  exitCode: number;
  filteredLineCount: number;
  diagnostics: TscDiagnostic[];
  truncated: boolean;
  countsByCode: Record<string, number>;
};

async function diagnostics(
  cwd: string,
  filePath: string,
  severity?: string,
): Promise<DiagnosticsRun> {
  const result = await runCommand(
    "bunx",
    ["tsc", "--noEmit", "--pretty", "false"],
    {
      cwd,
      timeoutMs: 120000,
    },
  );

  if (result.exitCode === 0) {
    return {
      text: "No diagnostics found",
      exitCode: 0,
      filteredLineCount: 0,
      diagnostics: [],
      truncated: false,
      countsByCode: {},
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        line.includes(basename(filePath)) || line.includes(resolve(filePath)),
    );

  const filtered =
    severity && severity !== "all"
      ? lines.filter((line) => parseSeverityLine(line) === severity)
      : lines;

  if (filtered.length === 0) {
    return {
      text: "No diagnostics found",
      exitCode: result.exitCode,
      filteredLineCount: 0,
      diagnostics: [],
      truncated: false,
      countsByCode: {},
    };
  }

  const limited = filtered.slice(0, 200);
  const text = limited.join("\n");
  const parsed = parseTscDiagnostics(text, 80);
  const diagnostics = parsed.diagnostics.filter((diagnostic) => {
    try {
      return resolve(cwd, diagnostic.file) === resolve(cwd, filePath);
    } catch {
      return false;
    }
  });

  const countsByCode: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    countsByCode[diagnostic.code] = (countsByCode[diagnostic.code] ?? 0) + 1;
  }

  return {
    text,
    exitCode: result.exitCode,
    filteredLineCount: filtered.length,
    diagnostics,
    truncated: parsed.truncated || filtered.length > limited.length,
    countsByCode,
  };
}

function applyRename(
  rootDir: string,
  oldName: string,
  newName: string,
): { filesChanged: number; replacements: number } {
  const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, "g");
  const files = walkCodeFiles(rootDir);
  let filesChanged = 0;
  let replacements = 0;

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const matches = content.match(pattern);
    if (!matches || matches.length === 0) continue;

    const next = content.replace(pattern, newName);
    if (next !== content) {
      writeFileSync(file, next, "utf8");
      filesChanged += 1;
      replacements += matches.length;
    }
  }

  return { filesChanged, replacements };
}

export function createLspTools(
  options?: { runtime?: BrewvaToolRuntime },
): ToolDefinition<any>[] {
  const lspGotoDefinition: ToolDefinition<any> = {
    name: "lsp_goto_definition",
    label: "LSP Go To Definition",
    description:
      "Heuristic-based (regex/file scan), not real LSP. Jump to likely symbol definition.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!existsSync(params.filePath))
        return textResult(`Error: File not found: ${params.filePath}`);

      const symbol = wordAt(params.filePath, params.line, params.character);
      if (!symbol) return textResult("No symbol found at cursor.");

      const scan: LspParallelReadContext = {
        runtime: options?.runtime,
        sessionId: getToolSessionId(ctx),
        toolName: "lsp_goto_definition",
        config: resolveParallelReadConfig(options?.runtime),
      };
      const matches = await findDefinition(
        ctx.cwd,
        symbol,
        scan,
        params.filePath,
        1,
      );
      if (matches.length === 0)
        return textResult(`No definition found for '${symbol}'.`);

      return textResult(matches.slice(0, 20).join("\n"), {
        symbol,
        count: matches.length,
      });
    },
  };

  const lspFindReferences: ToolDefinition<any> = {
    name: "lsp_find_references",
    label: "LSP Find References",
    description:
      "Heuristic-based (regex/file scan), not real LSP. Find likely symbol references.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
      includeDeclaration: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!existsSync(params.filePath))
        return textResult(`Error: File not found: ${params.filePath}`);

      const symbol = wordAt(params.filePath, params.line, params.character);
      if (!symbol) return textResult("No symbol found at cursor.");

      const scan: LspParallelReadContext = {
        runtime: options?.runtime,
        sessionId: getToolSessionId(ctx),
        toolName: "lsp_find_references",
        config: resolveParallelReadConfig(options?.runtime),
      };
      let refs = await findReferences(ctx.cwd, symbol, scan, 500);
      if (params.includeDeclaration === false) {
        const defs = new Set(
          await findDefinition(ctx.cwd, symbol, scan, params.filePath),
        );
        refs = refs.filter((line) => !defs.has(line));
      }

      if (refs.length === 0)
        return textResult(`No references found for '${symbol}'.`);

      return textResult(refs.slice(0, 200).join("\n"), {
        symbol,
        total: refs.length,
      });
    },
  };

  const lspSymbols: ToolDefinition<any> = {
    name: "lsp_symbols",
    label: "LSP Symbols",
    description:
      "Heuristic-based (regex/file scan), not real LSP. List symbols or search workspace.",
    parameters: Type.Object({
      filePath: Type.String(),
      scope: Type.Optional(
        Type.Union([Type.Literal("document"), Type.Literal("workspace")]),
      ),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "document";
      const limit = params.limit ?? 50;

      if (scope === "document") {
        if (!existsSync(params.filePath))
          return textResult(`Error: File not found: ${params.filePath}`);

        const symbols = listSymbolsInFile(params.filePath, limit);
        return textResult(
          symbols.length > 0 ? symbols.join("\n") : "No symbols found",
        );
      }

      if (!params.query || params.query.trim().length === 0) {
        return textResult("Error: query is required for workspace scope.");
      }

      const scan: LspParallelReadContext = {
        runtime: options?.runtime,
        sessionId: getToolSessionId(ctx),
        toolName: "lsp_symbols",
        config: resolveParallelReadConfig(options?.runtime),
      };
      const refs = await findReferences(ctx.cwd, params.query, scan, limit);
      return textResult(refs.length > 0 ? refs.join("\n") : "No symbols found");
    },
  };

  const lspDiagnostics: ToolDefinition<any> = {
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Runs TypeScript compiler (tsc). Not a real LSP server connection.",
    parameters: Type.Object({
      filePath: Type.String(),
      severity: Type.Optional(
        Type.Union([
          Type.Literal("error"),
          Type.Literal("warning"),
          Type.Literal("information"),
          Type.Literal("hint"),
          Type.Literal("all"),
        ]),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const run = await diagnostics(
          ctx.cwd,
          params.filePath,
          params.severity,
        );
        return textResult(run.text, {
          filePath: params.filePath,
          severity: params.severity ?? "all",
          exitCode: run.exitCode,
          filteredLineCount: run.filteredLineCount,
          diagnosticsCount: run.diagnostics.length,
          truncated: run.truncated,
          countsByCode: run.countsByCode,
          diagnostics: run.diagnostics,
        });
      } catch (error) {
        return textResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };

  const lspPrepareRename: ToolDefinition<any> = {
    name: "lsp_prepare_rename",
    label: "LSP Prepare Rename",
    description:
      "Heuristic-based. Checks rename availability via workspace scan (not real LSP).",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!existsSync(params.filePath))
        return textResult(`Error: File not found: ${params.filePath}`);

      const symbol = wordAt(params.filePath, params.line, params.character);
      if (!symbol)
        return textResult("Rename not available: cursor is not on a symbol.");

      const scan: LspParallelReadContext = {
        runtime: options?.runtime,
        sessionId: getToolSessionId(ctx),
        toolName: "lsp_prepare_rename",
        config: resolveParallelReadConfig(options?.runtime),
      };
      const refs = await findReferences(
        dirname(resolve(params.filePath)),
        symbol,
        scan,
        1000,
      );
      const definitions = await findDefinition(
        ctx.cwd,
        symbol,
        scan,
        params.filePath,
      );
      return textResult(
        `Rename available for '${symbol}'. Estimated references: ${refs.length}.`,
        {
          symbol,
          references: refs.length,
          definitions: definitions.length,
        },
      );
    },
  };

  const lspRename: ToolDefinition<any> = {
    name: "lsp_rename",
    label: "LSP Rename",
    description:
      "Heuristic-based global replacement (unsafe). Not real LSP rename.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
      newName: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!existsSync(params.filePath))
        return textResult(`Error: File not found: ${params.filePath}`);

      const symbol = wordAt(params.filePath, params.line, params.character);
      if (!symbol) return textResult("Error: cursor is not on a symbol.");

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.newName)) {
        return textResult("Error: newName must be a valid identifier.");
      }

      const result = applyRename(ctx.cwd, symbol, params.newName);
      return textResult(
        `Renamed '${symbol}' to '${params.newName}'. Files changed: ${result.filesChanged}, replacements: ${result.replacements}.`,
        result,
      );
    },
  };

  return [
    lspGotoDefinition,
    lspFindReferences,
    lspSymbols,
    lspDiagnostics,
    lspPrepareRename,
    lspRename,
  ];
}
