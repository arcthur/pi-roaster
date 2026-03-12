import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

function isLikelyText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 1024));
  let nonText = 0;
  for (const byte of sample.values()) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte !== 127) continue;
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

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const allowed =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0x7e);
    if (!allowed) return true;
    index += char.length;
  }
  return false;
}

function buildGoalKeywords(goal: string): string[] {
  const matches = goal.toLowerCase().match(/[a-z0-9._/-]+/g) ?? [];
  const filtered = matches.filter((entry) => entry.length >= 3);
  return [...new Set(filtered)];
}

type RelevantTextResult =
  | {
      kind: "match";
      excerpt: string;
      keywordCount: number;
      matchedLines: number;
    }
  | {
      kind: "unavailable";
      reason:
        | "goal_keywords_insufficient"
        | "no_high_confidence_match"
        | "unsupported_goal_language";
      nextStep: string;
    };

function extractRelevantText(text: string, goal: string): RelevantTextResult {
  const lines = text.split("\n");
  if (hasNonAscii(goal)) {
    return {
      kind: "unavailable",
      reason: "unsupported_goal_language",
      nextStep: "Use English ASCII goal text (symbols, strings, or function names).",
    };
  }
  const keywords = buildGoalKeywords(goal);
  if (keywords.length === 0) {
    return {
      kind: "unavailable",
      reason: "goal_keywords_insufficient",
      nextStep: "Provide a narrower goal with concrete symbols, strings, or function names.",
    };
  }

  const ranked = lines
    .map((line, index) => ({ line, index, score: scoreLine(line, keywords) }))
    .filter((row) => row.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, 12)
    .toSorted((a, b) => a.index - b.index);

  if (ranked.length === 0) {
    return {
      kind: "unavailable",
      reason: "no_high_confidence_match",
      nextStep: "Narrow file_path or add exact anchors (symbol, error text, or nearby string).",
    };
  }

  const out: string[] = [];
  for (const row of ranked) {
    out.push(`L${row.index + 1}: ${row.line}`);
  }
  return {
    kind: "match",
    excerpt: out.join("\n"),
    keywordCount: keywords.length,
    matchedLines: ranked.length,
  };
}

export function createLookAtTool(): ToolDefinition {
  return defineBrewvaTool({
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
        return failTextResult(`Error: File not found: ${absolute}`);
      }

      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        return failTextResult(`Error: Expected file path, got directory: ${absolute}`);
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
      const relevant = extractRelevantText(text, params.goal);
      if (relevant.kind === "unavailable") {
        return inconclusiveTextResult(
          [
            "look_at unavailable: no high-confidence match for the current goal.",
            `reason=${relevant.reason}`,
            `next_step=${relevant.nextStep}`,
            `File: ${absolute}`,
            `Goal: ${params.goal}`,
          ].join("\n"),
          {
            status: "unavailable",
            reason: relevant.reason,
            nextStep: relevant.nextStep,
            binary: false,
            size: stats.size,
          },
        );
      }

      return textResult(
        [`Analysis goal: ${params.goal}`, `File: ${absolute}`, "", relevant.excerpt].join("\n"),
        {
          status: "ok",
          binary: false,
          size: stats.size,
          keywordCount: relevant.keywordCount,
          matchedLines: relevant.matchedLines,
        },
      );
    },
  });
}
