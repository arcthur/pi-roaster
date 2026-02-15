import { createRequire } from "node:module";
import { getBinaryPath, getPlatformPackage } from "./bin/platform.js";

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

function main() {
  const { platform, arch } = process;
  const libcFamily = getLibcFamily();

  try {
    const pkg = getPlatformPackage({ platform, arch, libcFamily });
    const binPath = getBinaryPath(pkg, platform);
    require.resolve(binPath);
    console.log(`pi-roaster: installed platform binary for ${platform}-${arch}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`pi-roaster: ${message}`);
    console.warn("pi-roaster: platform binary is unavailable on this system.");
  }
}

main();
