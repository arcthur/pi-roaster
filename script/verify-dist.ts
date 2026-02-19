#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function runOrThrow(command: string, args: string[], options: { cwd: string; input?: string; step: string }): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    const stdout = result.stdout?.trim() ?? "";
    const details = [stderr, stdout].filter((part) => part.length > 0).join("\n");
    throw new Error(`${options.step} failed with exit code ${result.status}${details ? `\n${details}` : ""}`);
  }

  return result.stdout ?? "";
}

function main(): void {
  const repoRoot = process.cwd();
  const cliDistPath = resolve(repoRoot, "packages/brewva-cli/dist/index.js");
  if (!existsSync(cliDistPath)) {
    throw new Error(`CLI dist entry is missing: ${cliDistPath}. Run 'bun run typecheck' first.`);
  }

  const helpText = runOrThrow("node", [cliDistPath, "--help"], {
    cwd: repoRoot,
    step: "cli help smoke",
  });
  if (!helpText.includes("Brewva - AI-native coding agent CLI")) {
    throw new Error("cli help smoke failed: missing Brewva banner in dist output.");
  }

  const resolveScript = String.raw`
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const packages = [
      "@brewva/brewva-runtime",
      "@brewva/brewva-tools",
      "@brewva/brewva-extensions",
      "@brewva/brewva-cli",
    ];
    const resolved = packages.map((name) => ({ name, path: require.resolve(name) }));
    for (const entry of resolved) {
      if (!entry.path.includes("/dist/")) {
        throw new Error("expected dist entrypoint, got " + entry.path);
      }
    }
    await Promise.all(packages.map((name) => import(name)));
    console.log(JSON.stringify(resolved));
  `;

  runOrThrow("node", ["--input-type=module", "--eval", resolveScript], {
    cwd: repoRoot,
    step: "dist package import smoke",
  });

  console.log("dist smoke checks passed");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
