import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { distillToolOutput } from "./tool-output-distiller.js";

function extractTextOnlyContent(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const part = item as { type?: unknown; text?: unknown };
    if (part.type !== "text" || typeof part.text !== "string") {
      return undefined;
    }
    lines.push(part.text);
  }
  return lines.join("\n");
}

export function registerToolResultDistiller(_pi: ExtensionAPI, _runtime: BrewvaRuntime): void {
  _pi.on("tool_result", (event) => {
    const outputText = extractTextOnlyContent(event.content);
    if (outputText === undefined) {
      return undefined;
    }

    const details =
      event.details && typeof event.details === "object" && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : undefined;
    const verdict =
      details?.verdict === "pass" ||
      details?.verdict === "fail" ||
      details?.verdict === "inconclusive"
        ? details.verdict
        : undefined;
    const distillation = distillToolOutput({
      toolName: event.toolName,
      isError: event.isError,
      verdict,
      outputText,
    });
    if (!distillation.distillationApplied || !distillation.summaryText.trim()) {
      return undefined;
    }

    return {
      content: [{ type: "text", text: distillation.summaryText.trim() }],
    };
  });
}
