import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 1024));
  let nonText = 0;
  for (const byte of sample.values()) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    nonText += 1;
  }
  return nonText / Math.max(1, sample.length) < 0.2;
}

function safeReadTextFile(
  path: string,
  maxBytes: number,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  const st = statSync(path);
  if (!st.isFile()) return { ok: false, reason: "not_file" };
  const raw = readFileSync(path);
  if (!isLikelyText(raw)) return { ok: false, reason: "binary" };
  const text = raw.subarray(0, Math.min(raw.length, maxBytes)).toString("utf8");
  return { ok: true, text };
}

function tokenizeGoalTerms(goal: string): string[] {
  const matches = goal.toLowerCase().match(/[a-z0-9._/-]+/g) ?? [];
  const filtered = matches.filter((token) => token.length >= 3);
  return [...new Set(filtered)];
}

function scoreLine(line: string, keywords: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (keyword.length < 3) continue;
    if (lower.includes(keyword)) score += 1;
  }
  return score;
}

type RelevantExtractionMode = "keyword" | "fallback";

type RelevantExtraction = {
  mode: RelevantExtractionMode;
  hitLines: number;
  totalLines: number;
  lines: string[];
};

function extractRelevantLines(
  text: string,
  goal: string,
  limit: number,
): RelevantExtraction {
  const lines = text.split("\n");
  const keywords = tokenizeGoalTerms(goal);
  if (keywords.length === 0) {
    const extracted = lines
      .slice(0, Math.min(lines.length, 80))
      .map((line, index) => `L${index + 1}: ${line}`);
    return {
      mode: "fallback",
      hitLines: 0,
      totalLines: extracted.length,
      lines: extracted,
    };
  }

  const ranked = lines
    .map((line, index) => ({ line, index, score: scoreLine(line, keywords) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .sort((a, b) => a.index - b.index);

  if (ranked.length === 0) {
    const extracted = lines
      .slice(0, Math.min(lines.length, 80))
      .map((line, index) => `L${index + 1}: ${line}`);
    return {
      mode: "fallback",
      hitLines: 0,
      totalLines: extracted.length,
      lines: extracted,
    };
  }

  const extracted = ranked.map((row) => `L${row.index + 1}: ${row.line}`);
  return {
    mode: "keyword",
    hitLines: extracted.length,
    totalLines: extracted.length,
    lines: extracted,
  };
}

type ModuleEntry = {
  raw: string;
  source: string;
  names: string[];
  defaultImport?: string;
};

/** Extract import/export entries from the first N lines of source text.
 *  NOTE: Uses line-by-line regex matching — does not handle multi-line imports. */
function extractModuleEntries(
  text: string,
  maxLines: number,
  maxEntries: number,
): ModuleEntry[] {
  const entryLimit = Math.max(0, Math.floor(maxEntries));
  if (entryLimit === 0) return [];

  const lines = text.split("\n").slice(0, Math.max(1, maxLines));
  const out: ModuleEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const statement = trimmed.trimStart();
    if (!(statement.startsWith("import ") || statement.startsWith("export ")))
      continue;
    const sourceMatch = /\bfrom\s+["']([^"']+)["']/.exec(statement);
    if (!sourceMatch) continue;
    const source = sourceMatch[1]?.trim() ?? "";
    if (!source) continue;

    const names: string[] = [];
    let defaultImport: string | undefined;

    if (statement.startsWith("import ")) {
      const defaultMatch =
        /^\s*import\s+(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\s+from\b)/.exec(
          statement,
        );
      if (defaultMatch?.[1]) {
        defaultImport = defaultMatch[1];
      }
    }

    const braceMatch = /\{([^}]+)\}/.exec(statement);
    if (braceMatch) {
      const inside = braceMatch[1] ?? "";
      for (const part of inside.split(",")) {
        const cleaned = part.trim().replace(/^type\s+/, "");
        const base = cleaned.split(/\s+as\s+/i)[0]?.trim() ?? "";
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) {
          names.push(base);
        }
      }
    }

    out.push({ raw: statement, source, names, defaultImport });
    if (out.length >= entryLimit) break;
  }

  return out;
}

const MODULE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

function resolveModulePath(
  baseFile: string,
  specifier: string,
): string | undefined {
  const baseDir = dirname(baseFile);
  const base = resolve(baseDir, specifier);

  const candidates: string[] = [];
  candidates.push(base);
  for (const ext of MODULE_EXTS) {
    candidates.push(`${base}${ext}`);
  }
  for (const ext of MODULE_EXTS) {
    candidates.push(join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

function findDefinitionLines(
  text: string,
  symbol: string,
  limit: number,
): string[] {
  const lines = text.split("\n");
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(
      `\\bexport\\s+(?:default\\s+)?(?:declare\\s+)?(?:type|interface|class|function|const|let|var|enum)\\s+${escaped}\\b`,
    ),
    new RegExp(`\\bexport\\s+default\\s+${escaped}\\b`),
    new RegExp(
      `\\b(?:type|interface|class|function|const|let|var|enum)\\s+${escaped}\\b`,
    ),
  ];

  const matches: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (patterns.some((pattern) => pattern.test(line))) {
      matches.push(`L${i + 1}: ${line.trimEnd()}`);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function findDefaultExportLines(text: string, limit: number): string[] {
  const lines = text.split("\n");
  const matches: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/\bexport\s+default\b/.test(line)) continue;
    matches.push(`L${i + 1}: ${line.trimEnd()}`);
    if (matches.length >= limit) break;
  }
  return matches;
}

export interface ViewportMetrics {
  requestedFiles: string[];
  includedFiles: string[];
  unavailableFiles: Array<{ file: string; reason: string }>;
  importsExportsLines: number;
  relevantTotalLines: number;
  relevantHitLines: number;
  symbolLines: number;
  neighborhoodLines: number;
  snr: number | null;
  totalChars: number;
  truncated: boolean;
}

export interface ViewportContextResult {
  text: string;
  metrics: ViewportMetrics;
}

export function buildViewportContext(input: {
  cwd: string;
  goal: string;
  targetFiles: string[];
  targetSymbols?: string[];
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxImportsPerFile?: number;
  maxImportLines?: number;
  maxRelevantLines?: number;
  maxNeighborImports?: number;
  maxSymbolsPerImport?: number;
  maxDefinitionLines?: number;
  maxTotalChars?: number;
}): ViewportContextResult {
  const maxFiles = input.maxFiles ?? 3;
  const maxBytesPerFile = input.maxBytesPerFile ?? 120_000;
  const maxImportsPerFile = input.maxImportsPerFile ?? 12;
  const maxImportLines = input.maxImportLines ?? 60;
  const maxRelevantLines = input.maxRelevantLines ?? 14;
  const maxNeighborImports = input.maxNeighborImports ?? 4;
  const maxSymbolsPerImport = input.maxSymbolsPerImport ?? 6;
  const maxDefinitionLines = input.maxDefinitionLines ?? 2;
  const maxTotalChars = input.maxTotalChars ?? 8_000;

  const cwd = resolve(input.cwd);
  const files = input.targetFiles
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, maxFiles);
  const metrics: ViewportMetrics = {
    requestedFiles: files,
    includedFiles: [],
    unavailableFiles: [],
    importsExportsLines: 0,
    relevantTotalLines: 0,
    relevantHitLines: 0,
    symbolLines: 0,
    neighborhoodLines: 0,
    snr: null,
    totalChars: 0,
    truncated: false,
  };

  if (files.length === 0) {
    return {
      text: "",
      metrics,
    };
  }

  const targetSymbols = (input.targetSymbols ?? [])
    .map((symbol) => symbol.trim())
    .filter(Boolean)
    .slice(0, 8);

  const blocks: string[] = ["[Viewport]", `goal=${input.goal}`];

  for (const relative of files) {
    const absolute = resolve(cwd, relative);
    const content = safeReadTextFile(absolute, maxBytesPerFile);
    if (!content.ok) {
      blocks.push("");
      blocks.push(`File: ${relative}`);
      blocks.push(`status=unavailable reason=${content.reason}`);
      metrics.unavailableFiles.push({ file: relative, reason: content.reason });
      continue;
    }

    const moduleEntries = extractModuleEntries(
      content.text,
      maxImportLines,
      maxImportsPerFile,
    );
    const relevant = extractRelevantLines(
      content.text,
      input.goal,
      maxRelevantLines,
    );
    metrics.includedFiles.push(relative);
    metrics.importsExportsLines += moduleEntries.length;
    metrics.relevantTotalLines += relevant.totalLines;
    metrics.relevantHitLines += relevant.hitLines;

    blocks.push("");
    blocks.push(`File: ${relative}`);
    if (moduleEntries.length > 0) {
      blocks.push("importsExports:");
      for (const entry of moduleEntries) {
        blocks.push(`- ${entry.raw}`);
      }
    }

    blocks.push("relevant:");
    for (const line of relevant.lines) {
      blocks.push(`- ${line}`);
    }

    const symbolLines: string[] = [];
    if (targetSymbols.length > 0) {
      for (const symbol of targetSymbols) {
        const defs = findDefinitionLines(
          content.text,
          symbol,
          maxDefinitionLines,
        );
        for (const def of defs) {
          symbolLines.push(`- ${symbol}: ${def}`);
        }
      }
    }
    if (symbolLines.length > 0) {
      metrics.symbolLines += symbolLines.length;
      blocks.push("symbols:");
      blocks.push(...symbolLines);
    }

    const neighbor = moduleEntries
      .filter((entry) => entry.source.startsWith("."))
      .slice(0, maxNeighborImports);
    if (neighbor.length > 0) {
      blocks.push("neighborhood:");
      for (const entry of neighbor) {
        const resolved = resolveModulePath(absolute, entry.source);
        if (!resolved) continue;

        const neighborContent = safeReadTextFile(resolved, maxBytesPerFile);
        if (!neighborContent.ok) continue;

        let wroteAny = false;
        if (entry.defaultImport) {
          const defs = findDefaultExportLines(neighborContent.text, 1);
          for (const def of defs) {
            blocks.push(`- ${entry.source} default: ${def}`);
            metrics.neighborhoodLines += 1;
            wroteAny = true;
          }
        }

        const names = entry.names.slice(0, maxSymbolsPerImport);
        for (const name of names) {
          const defs = findDefinitionLines(
            neighborContent.text,
            name,
            maxDefinitionLines,
          );
          if (defs.length === 0) continue;
          for (const def of defs) {
            blocks.push(`- ${entry.source} ${name}: ${def}`);
            metrics.neighborhoodLines += 1;
            wroteAny = true;
          }
        }

        if (!wroteAny && names.length > 0) {
          blocks.push(
            `- ${entry.source}: (no definitions found for ${names.join(", ")})`,
          );
          metrics.neighborhoodLines += 1;
        }
      }
    }

    if (blocks.join("\n").length >= maxTotalChars) {
      break;
    }
  }

  const combined = blocks.join("\n").trim();
  const truncated = combined.length > maxTotalChars;
  const text = truncated
    ? `${combined.slice(0, maxTotalChars - 3)}...`
    : combined;

  const signal = metrics.relevantHitLines;
  const noise =
    metrics.relevantTotalLines -
    metrics.relevantHitLines +
    metrics.importsExportsLines +
    metrics.symbolLines +
    metrics.neighborhoodLines;
  metrics.snr = signal + noise > 0 ? signal / (signal + noise) : null;
  metrics.totalChars = text.length;
  metrics.truncated = truncated;

  return {
    text,
    metrics,
  };
}
