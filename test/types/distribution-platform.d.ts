declare module "../../distribution/pi-roaster/bin/platform.js" {
  export function getPlatformPackage(options: {
    platform: string;
    arch: string;
    libcFamily?: string | null;
  }): string;

  export function getBinaryPath(pkg: string, platform: string): string;
}
