import { distillToolOutput } from "./tool-output-distiller.js";

export type ToolDisplayVerdict = "pass" | "fail" | "inconclusive";

export interface ResolveToolDisplayTextInput {
  toolName: string;
  isError: boolean;
  result: unknown;
}

function normalizeToolDisplayVerdict(value: unknown): ToolDisplayVerdict | undefined {
  if (value === "pass" || value === "fail" || value === "inconclusive") {
    return value;
  }
  return undefined;
}

function extractResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  return details as Record<string, unknown>;
}

export function resolveToolDisplayVerdict(input: {
  isError: boolean;
  result: unknown;
}): ToolDisplayVerdict {
  if (input.result && typeof input.result === "object" && !Array.isArray(input.result)) {
    const explicit = normalizeToolDisplayVerdict((input.result as { verdict?: unknown }).verdict);
    if (explicit) return explicit;
  }
  const detailsVerdict = normalizeToolDisplayVerdict(extractResultDetails(input.result)?.verdict);
  if (detailsVerdict) return detailsVerdict;
  return input.isError ? "fail" : "pass";
}

export function resolveToolDisplayStatus(input: {
  isError: boolean;
  result: unknown;
}): "completed" | "failed" | "inconclusive" {
  const verdict = resolveToolDisplayVerdict(input);
  if (verdict === "fail") return "failed";
  if (verdict === "inconclusive") return "inconclusive";
  return "completed";
}

export function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text.trim());
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  try {
    const serialized = JSON.stringify(result);
    return serialized && serialized !== "{}" ? serialized : "";
  } catch {
    return "";
  }
}

export function resolveToolDisplayText(input: ResolveToolDisplayTextInput): string {
  const rawText = extractToolResultText(input.result);
  const verdict = resolveToolDisplayVerdict({
    isError: input.isError,
    result: input.result,
  });
  const distillation = distillToolOutput({
    toolName: input.toolName,
    isError: input.isError,
    verdict,
    outputText: rawText,
  });
  if (distillation.distillationApplied && distillation.summaryText.trim()) {
    return distillation.summaryText.trim();
  }
  return rawText;
}
