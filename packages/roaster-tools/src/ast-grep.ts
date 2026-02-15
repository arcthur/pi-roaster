import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runCommand } from "./utils/exec.js";
import { textResult } from "./utils/result.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

function walkFiles(baseDir: string, paths: string[] | undefined, max = 3000): string[] {
  const roots = paths && paths.length > 0 ? paths.map((path) => join(baseDir, path)) : [baseDir];
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= max) return;
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
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

function naiveSearch(cwd: string, pattern: string, paths?: string[], globs?: string[]): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    regex = new RegExp(escapeRegExp(pattern), "g");
  }

  const files = walkFiles(cwd, paths);
  const matches: string[] = [];

  for (const file of files) {
    if (!shouldInclude(file, globs)) continue;

    const ext = extname(file);
    if ([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip"].includes(ext)) continue;

    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        matches.push(`${file}:${i + 1}: ${line.trim()}`);
      }
      regex.lastIndex = 0;
      if (matches.length >= 200) break;
    }
    if (matches.length >= 200) break;
  }

  return matches.length > 0 ? matches.join("\n") : "No matches found";
}

function naiveReplace(cwd: string, pattern: string, rewrite: string, paths?: string[], globs?: string[], dryRun = true): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    regex = new RegExp(escapeRegExp(pattern), "g");
  }

  const files = walkFiles(cwd, paths);
  const updates: string[] = [];

  for (const file of files) {
    if (!shouldInclude(file, globs)) continue;

    const ext = extname(file);
    if ([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip"].includes(ext)) continue;

    const content = readFileSync(file, "utf8");
    const matches = content.match(regex);
    if (!matches || matches.length === 0) continue;

    const next = content.replace(regex, rewrite);
    updates.push(`${file} (${matches.length} replacements)`);
    if (!dryRun) {
      writeFileSync(file, next, "utf8");
    }
  }

  if (updates.length === 0) {
    return "No matches found";
  }

  return dryRun
    ? `Dry run only. Planned updates:\n${updates.join("\n")}`
    : `Applied updates:\n${updates.join("\n")}`;
}

export function createAstGrepTools(): ToolDefinition<any>[] {
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
        return textResult(naiveSearch(ctx.cwd, params.pattern, params.paths, params.globs), {
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
        return textResult(naiveReplace(ctx.cwd, params.pattern, params.rewrite, params.paths, params.globs, dryRun), {
          fallback: "regex",
        });
      }
    },
  };

  return [astGrepSearch, astGrepReplace];
}
