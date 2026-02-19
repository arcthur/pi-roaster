const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g, replacement: "sk-[redacted]" },
  { pattern: /\bghp_[A-Za-z0-9]{30,}\b/g, replacement: "ghp_[redacted]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, replacement: "github_pat_[redacted]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "AKIA[redacted]" },
  { pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, replacement: "xox-[redacted]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, replacement: "Bearer [redacted]" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement:
      "-----BEGIN [REDACTED PRIVATE KEY]-----\n...[redacted]...\n-----END [REDACTED PRIVATE KEY]-----",
  },
];

export function redactSecrets(text: string): string {
  let output = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactUnknown(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return redactSecrets(input);
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[redacted]";
    seen.add(input);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      out[key] = visit(item);
    }
    return out;
  };

  return visit(value);
}

