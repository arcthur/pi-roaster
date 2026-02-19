import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { textResult } from "./utils/result.js";

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

function scoreLine(line: string, keywords: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (keyword.length < 3) continue;
    if (lower.includes(keyword)) score += 1;
  }
  return score;
}

function extractRelevantText(text: string, goal: string): string {
  const lines = text.split("\n");
  const keywords = goal.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const ranked = lines
    .map((line, index) => ({ line, index, score: scoreLine(line, keywords) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .sort((a, b) => a.index - b.index);

  if (ranked.length === 0) {
    return lines.slice(0, 80).join("\n");
  }

  const out: string[] = [];
  for (const row of ranked) {
    out.push(`L${row.index + 1}: ${row.line}`);
  }
  return out.join("\n");
}

export function createLookAtTool(): ToolDefinition<any> {
  return {
    name: "look_at",
    label: "Look At",
    description: "Analyze file content and extract goal-focused findings.",
    parameters: Type.Object({
      file_path: Type.String(),
      goal: Type.String(),
    }),
    async execute(_id, params) {
      const absolute = resolve(params.file_path);
      if (!existsSync(absolute)) {
        return textResult(`Error: File not found: ${absolute}`);
      }

      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        return textResult(`Error: Expected file path, got directory: ${absolute}`);
      }

      const raw = readFileSync(absolute);
      const ext = extname(absolute).toLowerCase();

      if (!isLikelyText(raw)) {
        return textResult(
          [
            `Binary file detected: ${absolute}`,
            `size=${stats.size} bytes`,
            `extension=${ext || "(none)"}`,
            `goal=${params.goal}`,
            "Tip: use a multimodal model if deep media inspection is required.",
          ].join("\n"),
          { binary: true, size: stats.size },
        );
      }

      const text = raw.toString("utf8");
      const excerpt = extractRelevantText(text, params.goal);

      return textResult(
        [
          `Analysis goal: ${params.goal}`,
          `File: ${absolute}`,
          "",
          excerpt,
        ].join("\n"),
        { binary: false, size: stats.size },
      );
    },
  };
}
