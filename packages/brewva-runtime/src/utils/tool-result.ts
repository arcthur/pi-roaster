export type ToolResultVerdict = "pass" | "fail" | "inconclusive";

export function normalizeToolResultVerdict(value: unknown): ToolResultVerdict | undefined {
  if (value === "pass" || value === "fail" || value === "inconclusive") {
    return value;
  }
  return undefined;
}

export function resolveToolResultVerdict(input: {
  verdict?: unknown;
  channelSuccess: boolean;
}): ToolResultVerdict {
  return normalizeToolResultVerdict(input.verdict) ?? (input.channelSuccess ? "pass" : "fail");
}

export function isToolResultPass(verdict: ToolResultVerdict): boolean {
  return verdict === "pass";
}

export function isToolResultFail(verdict: ToolResultVerdict): boolean {
  return verdict === "fail";
}

export function isToolResultInconclusive(verdict: ToolResultVerdict): boolean {
  return verdict === "inconclusive";
}
