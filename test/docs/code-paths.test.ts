import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

type InlineCodeRef = {
  sourceFile: string;
  lineNumber: number;
  raw: string;
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

function extractInlineCodeRefs(markdown: string, sourceFile: string): InlineCodeRef[] {
  const lines = stripCodeFencesLines(markdown.split("\n"));
  const refs: InlineCodeRef[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const regex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      refs.push({ sourceFile, lineNumber: i + 1, raw: match[1] ?? "" });
    }
  }

  return refs;
}

function isRepoPathCandidate(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (value.includes(" ")) return false;
  if (/[*?[\]]/.test(value)) return false;
  if (/[<>]/.test(value)) return false;
  if (/[{}]/.test(value)) return false;
  return /^(src|docs|script|packages|distribution|skills)\//.test(value);
}

describe("docs code path refs", () => {
  it("inline code path references exist in repo (docs tree)", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const docsDir = resolve(repoRoot, "docs");
    const markdownFiles = listMarkdownFiles(docsDir);

    const errors: string[] = [];

    for (const filePath of markdownFiles) {
      const markdown = readFileSync(filePath, "utf-8");
      const refs = extractInlineCodeRefs(markdown, filePath);

      for (const ref of refs) {
        const value = ref.raw.trim();
        if (!isRepoPathCandidate(value)) continue;

        const resolvedPath = resolve(repoRoot, value);
        if (!existsSync(resolvedPath)) {
          errors.push(`${ref.sourceFile}:${ref.lineNumber} missing path \`${value}\` (resolved: ${resolvedPath})`);
        }
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
