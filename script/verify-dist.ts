#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.12.0";

function runOrThrow(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; step: string },
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`${options.step} failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    const stdout = result.stdout?.trim() ?? "";
    const details = [stderr, stdout].filter((part) => part.length > 0).join("\n");
    throw new Error(
      `${options.step} failed with exit code ${result.status}${details ? `\n${details}` : ""}`,
    );
  }

  return result.stdout ?? "";
}

type Semver = Readonly<{ major: number; minor: number; patch: number }>;

function parseSemver(versionText: string): Semver | null {
  const trimmed = versionText.trim();
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(trimmed);
  if (!match?.groups) return null;

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);

  if (!Number.isInteger(major) || major < 0) return null;
  if (!Number.isInteger(minor) || minor < 0) return null;
  if (!Number.isInteger(patch) || patch < 0) return null;

  return { major, minor, patch };
}

function isSupportedNodeVersion(version: Semver): boolean {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 12;
  return version.major > 22;
}

function assertSupportedNodeRuntime(repoRoot: string): void {
  const versionText = runOrThrow("node", ["--version"], {
    cwd: repoRoot,
    step: "node version check",
  });
  const parsed = parseSemver(versionText);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    throw new Error(
      `node version check failed: detected ${versionText.trim()}, expected Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
  }
}

function main(): void {
  const repoRoot = process.cwd();
  assertSupportedNodeRuntime(repoRoot);

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
      "@brewva/brewva-addons",
      "@brewva/brewva-runtime",
      "@brewva/brewva-channels-telegram",
      "@brewva/brewva-ingress",
      "@brewva/brewva-tools",
      "@brewva/brewva-gateway/runtime-plugins",
      "@brewva/brewva-cli",
      "@brewva/brewva-gateway",
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
