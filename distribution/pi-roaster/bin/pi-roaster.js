#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { getBinaryPath, getPlatformPackage } from "./platform.js";

const require = createRequire(import.meta.url);

function getLibcFamily() {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const detectLibc = require("detect-libc");
    return detectLibc.familySync();
  } catch {
    return null;
  }
}

function resolveBinaryPath() {
  const { platform, arch } = process;
  const libcFamily = getLibcFamily();

  const pkg = getPlatformPackage({ platform, arch, libcFamily });
  const binRelPath = getBinaryPath(pkg, platform);

  try {
    return require.resolve(binRelPath);
  } catch {
    const suffix = libcFamily === "musl" ? "-musl" : "";
    throw new Error(
      [
        "platform binary is not installed.",
        `platform: ${platform}-${arch}${suffix}`,
        `expected package: ${pkg}`,
        `try: npm install ${pkg}`,
      ].join("\n"),
    );
  }
}

function main() {
  let binPath;
  try {
    binPath = resolveBinaryPath();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pi-roaster: ${message}`);
    process.exit(1);
  }

  const result = spawnSync(binPath, process.argv.slice(2), {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`pi-roaster: failed to execute binary: ${result.error.message}`);
    process.exit(2);
  }

  if (result.signal) {
    const signalCode =
      result.signal === "SIGTERM" ? 15 : result.signal === "SIGKILL" ? 9 : result.signal === "SIGINT" ? 2 : 1;
    process.exit(128 + signalCode);
  }

  process.exit(result.status ?? 1);
}

main();
