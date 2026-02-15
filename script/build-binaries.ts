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

const roasterCliRequire = createRequire(join(process.cwd(), "packages/roaster-cli/package.json"));

export const PLATFORMS: PlatformTarget[] = [
  { dir: "pi-roaster-darwin-arm64", target: "bun-darwin-arm64", binary: "pi-roaster", description: "macOS ARM64" },
  { dir: "pi-roaster-darwin-x64", target: "bun-darwin-x64", binary: "pi-roaster", description: "macOS x64" },
  { dir: "pi-roaster-linux-x64", target: "bun-linux-x64", binary: "pi-roaster", description: "Linux x64 (glibc)" },
  { dir: "pi-roaster-linux-arm64", target: "bun-linux-arm64", binary: "pi-roaster", description: "Linux ARM64 (glibc)" },
  { dir: "pi-roaster-linux-x64-musl", target: "bun-linux-x64-musl", binary: "pi-roaster", description: "Linux x64 (musl)" },
  { dir: "pi-roaster-linux-arm64-musl", target: "bun-linux-arm64-musl", binary: "pi-roaster", description: "Linux ARM64 (musl)" },
  { dir: "pi-roaster-windows-x64", target: "bun-windows-x64", binary: "pi-roaster.exe", description: "Windows x64" },
];

const ENTRY_POINT = "packages/roaster-cli/src/index.ts";
const WRAPPER_PACKAGE_JSON = "distribution/pi-roaster/package.json";

const PI_CODING_AGENT_DIR = dirname(roasterCliRequire.resolve("@mariozechner/pi-coding-agent/package.json"));
const piCodingAgentRequire = createRequire(join(PI_CODING_AGENT_DIR, "package.json"));
const PHOTON_WASM_PATH = join(
  dirname(piCodingAgentRequire.resolve("@silvia-odwyer/photon-node/package.json")),
  "photon_rs_bg.wasm",
);

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
      name: wrapperPackage.piConfig?.name ?? "pi-roaster",
      configDir: wrapperPackage.piConfig?.configDir ?? ".pi",
    },
  };

  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);

  copyFile(join(PI_CODING_AGENT_DIR, "README.md"), join(outDir, "README.md"));
  copyFile(join(PI_CODING_AGENT_DIR, "CHANGELOG.md"), join(outDir, "CHANGELOG.md"));
  copyFile(PHOTON_WASM_PATH, join(outDir, "photon_rs_bg.wasm"));

  copyDirectory(join(PI_CODING_AGENT_DIR, "docs"), join(outDir, "docs"));
  copyDirectory(join(PI_CODING_AGENT_DIR, "examples"), join(outDir, "examples"));
  copyDirectory(join(PI_CODING_AGENT_DIR, "dist", "modes", "interactive", "theme"), join(outDir, "theme"));
  copyDirectory(join(PI_CODING_AGENT_DIR, "dist", "core", "export-html"), join(outDir, "export-html"));
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
  console.log("Building pi-roaster platform binaries");
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
