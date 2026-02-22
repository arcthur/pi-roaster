const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeForCompare(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizeGatewayHost(host: string | undefined): string {
  const normalized = typeof host === "string" ? host.trim() : "";
  return normalized.length > 0 ? normalized : "127.0.0.1";
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeForCompare(host));
}

export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `gateway host must stay on loopback (${host}); use VPN/Tailscale instead of exposing control-plane ports`,
    );
  }
}
