const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-musl",
  "windows-x64",
]);

/**
 * Resolve the platform package name for the running system.
 *
 * @param {{ platform: string, arch: string, libcFamily?: string | null }} options
 * @returns {string}
 */
export function getPlatformPackage({ platform, arch, libcFamily }) {
  let suffix = "";
  if (platform === "linux") {
    if (libcFamily === null || libcFamily === undefined) {
      throw new Error(
        "could not detect Linux libc family (expected glibc or musl).",
      );
    }
    if (libcFamily === "musl") {
      suffix = "-musl";
    }
  }

  const os = platform === "win32" ? "windows" : platform;
  const target = `${os}-${arch}${suffix}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`unsupported platform target: ${platform}-${arch}${suffix}`);
  }

  return `@pi-roaster/pi-roaster-${target}`;
}

/**
 * Resolve the binary path inside a platform package.
 *
 * @param {string} pkg
 * @param {string} platform
 * @returns {string}
 */
export function getBinaryPath(pkg, platform) {
  const ext = platform === "win32" ? ".exe" : "";
  return `${pkg}/bin/pi-roaster${ext}`;
}
