import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type MarkdownLink = {
  sourceFile: string;
  lineNumber: number;
  rawTarget: string;
};

function listMarkdownFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }

    if (entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

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

function slugifyHeading(text: string): string {
  return text
    .trim()
    .replace(/\s+#+\s*$/, "")
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getHeadingAnchors(markdown: string): Set<string> {
  const lines = stripCodeFencesLines(markdown.split("\n"));
  const anchors = new Set<string>();
  const counts = new Map<string, number>();

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!match) continue;

    const headingText = match[2] ?? "";
    const base = slugifyHeading(headingText);
    if (!base) continue;

    const current = counts.get(base) ?? 0;
    const anchor = current === 0 ? base : `${base}-${current}`;
    counts.set(base, current + 1);
    anchors.add(anchor);
  }

  return anchors;
}

describe("docs markdown links", () => {
  it("all local markdown links resolve", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const docsDir = resolve(repoRoot, "docs");
    const markdownFiles = listMarkdownFiles(docsDir);

    const errors: string[] = [];
    const anchorCache = new Map<string, Set<string>>();

    for (const filePath of markdownFiles) {
      const markdown = readFileSync(filePath, "utf-8");
      const links = extractLinks(markdown, filePath);

      for (const link of links) {
        const target = normalizeLinkTarget(link.rawTarget);
        if (!target || isExternalLink(target)) continue;

        const [pathPartRaw = "", anchorPartRaw = ""] = target.split("#", 2);

        if (!pathPartRaw && target.startsWith("#")) {
          const anchors =
            anchorCache.get(filePath) ??
            (() => {
              const computed = getHeadingAnchors(markdown);
              anchorCache.set(filePath, computed);
              return computed;
            })();

          if (!anchors.has(anchorPartRaw)) {
            errors.push(`${filePath}:${link.lineNumber} broken anchor link "#${anchorPartRaw}"`);
          }
          continue;
        }

        const decodedPath = decodeURIComponent(pathPartRaw);
        const resolvedPath = resolve(dirname(filePath), decodedPath);

        if (!existsSync(resolvedPath)) {
          errors.push(`${filePath}:${link.lineNumber} missing link target "${target}" (resolved: ${resolvedPath})`);
          continue;
        }

        if (anchorPartRaw && resolvedPath.endsWith(".md")) {
          const targetMarkdown = readFileSync(resolvedPath, "utf-8");
          const anchors =
            anchorCache.get(resolvedPath) ??
            (() => {
              const computed = getHeadingAnchors(targetMarkdown);
              anchorCache.set(resolvedPath, computed);
              return computed;
            })();

          if (!anchors.has(anchorPartRaw)) {
            errors.push(`${filePath}:${link.lineNumber} broken anchor link "${target}" (missing "#${anchorPartRaw}")`);
          }
        }
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
