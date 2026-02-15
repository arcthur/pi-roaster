import { describe, expect, test } from "bun:test";
import { getBinaryPath, getPlatformPackage } from "../../distribution/pi-roaster/bin/platform.js";

describe("pi-roaster platform package resolution", () => {
  test("resolves macOS package names", () => {
    expect(getPlatformPackage({ platform: "darwin", arch: "arm64" })).toBe("@pi-roaster/pi-roaster-darwin-arm64");
    expect(getPlatformPackage({ platform: "darwin", arch: "x64" })).toBe("@pi-roaster/pi-roaster-darwin-x64");
  });

  test("resolves linux package names with libc", () => {
    expect(getPlatformPackage({ platform: "linux", arch: "x64", libcFamily: "glibc" })).toBe(
      "@pi-roaster/pi-roaster-linux-x64",
    );
    expect(getPlatformPackage({ platform: "linux", arch: "x64", libcFamily: "musl" })).toBe(
      "@pi-roaster/pi-roaster-linux-x64-musl",
    );
  });

  test("maps win32 platform to windows package names", () => {
    expect(getPlatformPackage({ platform: "win32", arch: "x64" })).toBe("@pi-roaster/pi-roaster-windows-x64");
    expect(getBinaryPath("@pi-roaster/pi-roaster-windows-x64", "win32")).toBe(
      "@pi-roaster/pi-roaster-windows-x64/bin/pi-roaster.exe",
    );
  });

  test("throws for unsupported or unknown Linux libc", () => {
    expect(() => getPlatformPackage({ platform: "linux", arch: "x64", libcFamily: null })).toThrow();
    expect(() => getPlatformPackage({ platform: "freebsd", arch: "x64" })).toThrow();
  });
});
