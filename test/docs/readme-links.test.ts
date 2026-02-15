import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type MarkdownLink = {
  sourceFile: string;
  lineNumber: number;
  rawTarget: string;
};

function stripCodeFencesLines(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (!inFence) out.push(line);
  }

  return out;
}

function extractLinks(markdown: string, sourceFile: string): MarkdownLink[] {
  const lines = markdown.split("\n");
  const visibleLines = stripCodeFencesLines(lines);
  const links: MarkdownLink[] = [];

  for (let i = 0; i < visibleLines.length; i += 1) {
    const line = visibleLines[i] ?? "";
    const regex = /\[[^\]]*]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      links.push({
        sourceFile,
        lineNumber: i + 1,
        rawTarget: match[1] ?? "",
      });
    }
  }

  return links;
}

function normalizeLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.split(/\s+/)[0] ?? "";
}

function isExternalLink(target: string): boolean {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("data:")
  );
}

describe("README markdown links", () => {
  it("README.md local links resolve", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const readmePath = resolve(rootDir, "README.md");
    const markdown = readFileSync(readmePath, "utf-8");
    const links = extractLinks(markdown, readmePath);

    const errors: string[] = [];

    for (const link of links) {
      const target = normalizeLinkTarget(link.rawTarget);
      if (!target || isExternalLink(target)) continue;
      if (target.startsWith("#")) continue;

      const [pathWithQuery = ""] = target.split("#", 1);
      const [pathPartRaw = ""] = pathWithQuery.split("?", 1);
      const decodedPath = decodeURIComponent(pathPartRaw);
      const resolvedPath = resolve(dirname(readmePath), decodedPath);

      if (!existsSync(resolvedPath)) {
        errors.push(`${readmePath}:${link.lineNumber} missing link target "${target}" (resolved: ${resolvedPath})`);
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
