import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readSourceTextWithCache, registerTocSourceCacheRuntime } from "./toc-cache.js";
import type { BrewvaToolRuntime } from "./types.js";
import { getToolSessionId } from "./utils/parallel-read.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const MAX_SPANS = 16;
const MAX_TOTAL_RETURN_LINES = 400;

interface NormalizedSpan {
  startLine: number;
  endLine: number;
}

function normalizeSpans(spans: Array<{ start_line: number; end_line: number }>): NormalizedSpan[] {
  const normalized = spans
    .map((span) => ({
      startLine: Math.max(1, Math.floor(span.start_line)),
      endLine: Math.max(1, Math.floor(span.end_line)),
    }))
    .map((span) =>
      span.endLine < span.startLine ? { startLine: span.endLine, endLine: span.startLine } : span,
    )
    .toSorted((left, right) => {
      if (left.startLine !== right.startLine) return left.startLine - right.startLine;
      return left.endLine - right.endLine;
    });

  const merged: NormalizedSpan[] = [];
  for (const span of normalized) {
    const last = merged.at(-1);
    if (last && span.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, span.endLine);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function formatSpan(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
}

export function createReadSpansTool(options?: { runtime?: BrewvaToolRuntime }): ToolDefinition {
  registerTocSourceCacheRuntime(options?.runtime);
  return defineBrewvaTool({
    name: "read_spans",
    label: "Read Spans",
    description:
      "Read bounded line ranges from one file. Prefer this after toc_document/toc_search instead of whole-file reads.",
    parameters: Type.Object({
      file_path: Type.String({ minLength: 1 }),
      spans: Type.Array(
        Type.Object({
          start_line: Type.Integer({ minimum: 1 }),
          end_line: Type.Integer({ minimum: 1 }),
        }),
        { minItems: 1, maxItems: MAX_SPANS },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const baseDir =
        ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();
      const absolutePath = resolve(baseDir, params.file_path);
      if (!existsSync(absolutePath)) {
        return failTextResult(`Error: File not found: ${absolutePath}`);
      }

      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        return failTextResult(`Error: Path is not a file: ${absolutePath}`);
      }

      const source = readSourceTextWithCache({
        sessionId: getToolSessionId(ctx),
        absolutePath,
        signature: `${stats.mtimeMs}:${stats.size}`,
      });
      const lines = source.lines;
      const normalized = normalizeSpans(params.spans);
      if (normalized.length === 0) {
        return inconclusiveTextResult(
          [
            "read_spans unavailable: no valid spans after normalization.",
            "reason=no_valid_spans",
            "next_step=Provide one or more positive line ranges.",
          ].join("\n"),
          {
            status: "unavailable",
            reason: "no_valid_spans",
            nextStep: "Provide one or more positive line ranges.",
          },
        );
      }

      const bounded = normalized
        .map((span) => ({
          startLine: span.startLine,
          endLine: Math.min(span.endLine, lines.length),
        }))
        .filter((span) => span.startLine <= lines.length && span.endLine >= span.startLine);
      if (bounded.length === 0) {
        return inconclusiveTextResult(
          [
            "read_spans unavailable: requested spans are outside the file.",
            "reason=out_of_bounds",
            `file: ${absolutePath}`,
            `total_lines: ${lines.length}`,
            "next_step=Use line spans returned by toc_document/toc_search or a lower range.",
          ].join("\n"),
          {
            status: "unavailable",
            reason: "out_of_bounds",
            totalLines: lines.length,
            nextStep: "Use line spans returned by toc_document/toc_search or a lower range.",
          },
        );
      }

      const output: string[] = [
        "[ReadSpans]",
        `file: ${absolutePath}`,
        `requested_spans: ${normalized.map((span) => formatSpan(span.startLine, span.endLine)).join(", ")}`,
        `returned_spans: ${bounded.map((span) => formatSpan(span.startLine, span.endLine)).join(", ")}`,
        `total_lines: ${lines.length}`,
      ];

      let emittedLines = 0;
      let truncated = false;
      let lastLineReturned: number | null = null;
      let truncatedAtLine: number | null = null;
      for (const span of bounded) {
        if (emittedLines >= MAX_TOTAL_RETURN_LINES) {
          truncated = true;
          truncatedAtLine ??= span.startLine;
          break;
        }
        output.push("", `[Span ${formatSpan(span.startLine, span.endLine)}]`);
        for (let lineNumber = span.startLine; lineNumber <= span.endLine; lineNumber += 1) {
          if (emittedLines >= MAX_TOTAL_RETURN_LINES) {
            truncated = true;
            truncatedAtLine ??= lineNumber;
            break;
          }
          output.push(`L${lineNumber}: ${lines[lineNumber - 1] ?? ""}`);
          emittedLines += 1;
          lastLineReturned = lineNumber;
        }
      }

      if (truncated) {
        output.push(
          "",
          `[Truncated] max_total_return_lines=${MAX_TOTAL_RETURN_LINES} last_line_returned=${lastLineReturned ?? "n/a"} truncated_at_line=${truncatedAtLine ?? "n/a"}`,
        );
      }

      return textResult(output.join("\n"), {
        status: "ok",
        filePath: absolutePath,
        sourceCacheHit: source.cacheHit,
        totalLines: lines.length,
        spansRequested: normalized.length,
        spansReturned: bounded.length,
        emittedLines,
        lastLineReturned,
        truncated,
        truncatedAtLine,
      });
    },
  });
}
