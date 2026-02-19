#!/usr/bin/env bun

import { $ } from "bun";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface PlatformTarget {
  dir: string;
  target: string;
  binary: string;
  description: string;
}

interface RuntimePackageJson {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type?: string;
  piConfig?: {
    name?: string;
    configDir?: string;
  };
}

const brewvaCliRequire = createRequire(join(process.cwd(), "packages/brewva-cli/package.json"));

export const PLATFORMS: PlatformTarget[] = [
  { dir: "brewva-darwin-arm64", target: "bun-darwin-arm64", binary: "brewva", description: "macOS ARM64" },
  { dir: "brewva-darwin-x64", target: "bun-darwin-x64", binary: "brewva", description: "macOS x64" },
  { dir: "brewva-linux-x64", target: "bun-linux-x64", binary: "brewva", description: "Linux x64 (glibc)" },
  { dir: "brewva-linux-arm64", target: "bun-linux-arm64", binary: "brewva", description: "Linux ARM64 (glibc)" },
  { dir: "brewva-linux-x64-musl", target: "bun-linux-x64-musl", binary: "brewva", description: "Linux x64 (musl)" },
  { dir: "brewva-linux-arm64-musl", target: "bun-linux-arm64-musl", binary: "brewva", description: "Linux ARM64 (musl)" },
  { dir: "brewva-windows-x64", target: "bun-windows-x64", binary: "brewva.exe", description: "Windows x64" },
];

const ENTRY_POINT = "packages/brewva-cli/src/index.ts";
const WRAPPER_PACKAGE_JSON = "distribution/brewva/package.json";

const PI_CODING_AGENT_DIR = dirname(brewvaCliRequire.resolve("@mariozechner/pi-coding-agent/package.json"));
const piCodingAgentRequire = createRequire(join(PI_CODING_AGENT_DIR, "package.json"));
const PHOTON_WASM_PATH = join(
  dirname(piCodingAgentRequire.resolve("@silvia-odwyer/photon-node/package.json")),
  "photon_rs_bg.wasm",
);
const BREWVA_CONFIG_SCHEMA_PATH = join(process.cwd(), "packages", "brewva-runtime", "schema", "brewva.schema.json");

function copyDirectory(source: string, target: string): void {
  if (!existsSync(source)) return;
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function copyFile(source: string, target: string): void {
  if (!existsSync(source)) return;
  cpSync(source, target);
}

function copyRuntimeAssets(outDir: string): void {
  const wrapperPackage = JSON.parse(readFileSync(WRAPPER_PACKAGE_JSON, "utf8")) as RuntimePackageJson;
  const runtimePackage: RuntimePackageJson = {
    name: wrapperPackage.name,
    version: wrapperPackage.version,
    description: wrapperPackage.description,
    license: wrapperPackage.license,
    type: wrapperPackage.type ?? "module",
    piConfig: {
      name: wrapperPackage.piConfig?.name ?? "brewva",
      configDir: wrapperPackage.piConfig?.configDir ?? ".config/brewva",
    },
  };

  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);

  copyFile(join(PI_CODING_AGENT_DIR, "README.md"), join(outDir, "README.md"));
  copyFile(join(PI_CODING_AGENT_DIR, "CHANGELOG.md"), join(outDir, "CHANGELOG.md"));
  copyFile(PHOTON_WASM_PATH, join(outDir, "photon_rs_bg.wasm"));
  copyFile(BREWVA_CONFIG_SCHEMA_PATH, join(outDir, "brewva.schema.json"));

  copyDirectory(join(PI_CODING_AGENT_DIR, "docs"), join(outDir, "docs"));
  copyDirectory(join(PI_CODING_AGENT_DIR, "examples"), join(outDir, "examples"));
  copyDirectory(join(PI_CODING_AGENT_DIR, "dist", "modes", "interactive", "theme"), join(outDir, "theme"));
  copyDirectory(join(PI_CODING_AGENT_DIR, "dist", "core", "export-html"), join(outDir, "export-html"));
  copyDirectory(join(process.cwd(), "skills"), join(outDir, "skills"));
}

async function buildPlatform(platform: PlatformTarget): Promise<boolean> {
  const outDir = join("distribution", platform.dir, "bin");
  const outfile = join(outDir, platform.binary);

  console.log(`\nBuilding ${platform.description}...`);
  console.log(`  target: ${platform.target}`);
  console.log(`  output: ${outfile}`);

  try {
    await $`bun build --compile --minify --target=${platform.target} ${ENTRY_POINT} --outfile=${outfile}`;

    if (!existsSync(outfile)) {
      console.error(`  failed: output binary missing at ${outfile}`);
      return false;
    }

    copyRuntimeAssets(outDir);

    if (process.platform !== "win32") {
      const fileInfo = await $`file ${outfile}`.text();
      console.log(`  ok: ${fileInfo.trim()}`);
    } else {
      console.log("  ok: binary created");
    }

    return true;
  } catch (error) {
    console.error(`  failed: ${error}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("Building Brewva platform binaries");
  console.log(`  entry point: ${ENTRY_POINT}`);
  console.log(`  platforms: ${PLATFORMS.length}`);

  if (!existsSync(ENTRY_POINT)) {
    console.error(`entry point not found: ${ENTRY_POINT}`);
    process.exit(1);
  }

  const results: Array<{ platform: string; success: boolean }> = [];
  for (const platform of PLATFORMS) {
    const success = await buildPlatform(platform);
    results.push({ platform: platform.description, success });
  }

  const succeeded = results.filter((result) => result.success).length;
  const failed = results.length - succeeded;

  console.log("\nBuild summary:");
  for (const result of results) {
    const status = result.success ? "ok" : "failed";
    console.log(`  [${status}] ${result.platform}`);
  }
  console.log(`  total: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("fatal error:", error);
  process.exit(1);
});
