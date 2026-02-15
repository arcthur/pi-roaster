import type { VerificationEvidence } from "../types.js";

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "lsp_rename",
  "ast_grep_replace",
]);
const LSP_DIAG_TOOLS = new Set(["lsp_diagnostics"]);
const TEST_PATTERNS = [
  /\b(test|tests|vitest|jest|pytest|go test|cargo test)\b/i,
  /\b(build|typecheck|tsc|mypy|ruff|eslint)\b/i,
];

function getCommand(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const cmd = args.command ?? args.cmd ?? args.script;
  return typeof cmd === "string" ? cmd : "";
}

export function isMutationTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName.toLowerCase());
}

export function classifyEvidence(input: {
  now: number;
  toolName: string;
  args?: Record<string, unknown>;
  outputText?: string;
  success: boolean;
}): VerificationEvidence[] {
  if (!input.success) {
    return [];
  }

  const outputText = (input.outputText ?? "").toLowerCase();
  const toolName = input.toolName.toLowerCase();
  const evidence: VerificationEvidence[] = [];

  if (LSP_DIAG_TOOLS.has(toolName)) {
    const severity = input.args?.severity;
    const unfiltered = severity === undefined || severity === null || severity === "all" || severity === "";
    if (unfiltered && outputText.includes("no diagnostics found")) {
      evidence.push({
        kind: "lsp_clean",
        timestamp: input.now,
        tool: input.toolName,
        detail: "tsc diagnostics clean",
        mode: "compiler",
      });
    }
  }

  if (toolName === "bash" || toolName === "shell") {
    const cmd = getCommand(input.args);
    if (cmd && TEST_PATTERNS.some((pattern) => pattern.test(cmd))) {
      evidence.push({
        kind: "test_or_build_passed",
        timestamp: input.now,
        tool: input.toolName,
        detail: cmd.slice(0, 200),
        mode: "command",
      });
    }
  }

  return evidence;
}
