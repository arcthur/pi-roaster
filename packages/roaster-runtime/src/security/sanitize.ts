const SUSPICIOUS_PATTERNS: RegExp[] = [
  /ignore previous instructions/gi,
  /system prompt/gi,
  /developer instructions/gi,
  /run this command exactly/gi,
  /tool_call\(/gi,
  /bypass security/gi,
];

export function sanitizeContextText(text: string): string {
  let output = text;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}
