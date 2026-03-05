import { isRecord, normalizeNonEmptyString } from "../utils/coerce.js";
import type { JsonValue } from "../utils/json.js";
import { parseTscDiagnostics } from "./tsc.js";

export type EvidenceArtifact = Record<string, JsonValue> & { kind: string };
export type CommandFailureClass =
  | "execution"
  | "invocation_validation"
  | "shell_syntax"
  | "script_composition";

function getCommand(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const cmd = args.command ?? args.cmd ?? args.script;
  return normalizeNonEmptyString(cmd);
}

function getDiagnosticTarget(args: Record<string, unknown> | undefined): {
  filePath?: string;
  severityFilter?: string;
} {
  if (!args) return {};
  const filePath = normalizeNonEmptyString(args.filePath);
  const severityFilter = normalizeNonEmptyString(args.severity);
  return {
    filePath: filePath ?? undefined,
    severityFilter: severityFilter ?? undefined,
  };
}

function extractExitCode(details: unknown): number | null {
  if (!isRecord(details)) return null;
  const direct = details.exitCode;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  const result = details.result;
  if (isRecord(result)) {
    const exitCode = result.exitCode;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode;
  }
  return null;
}

function extractLines(text: string, pattern: RegExp, limit: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!pattern.test(line)) continue;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueLines(lines: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

const INVOCATION_VALIDATION_PATTERN =
  /\b(invalid\s+(?:arguments?|params?|parameters?)|missing\s+required|schema\s+validation|must\s+be\s+(?:an?\s+)?(?:integer|number|string|boolean)|must\s+be\s+(?:<=|>=|<|>)|expected\s+type|unexpected\s+argument)\b/iu;
const INVOCATION_VALIDATION_OUTPUT_PATTERN =
  /(?:^|\n)\s*(?:error:\s*)?(?:invalid\s+(?:arguments?|params?|parameters?)|schema\s+validation|missing\s+required|unexpected\s+argument|unknown\s+argument|unknown\s+option|invalid\s+value\s+for)\b/iu;
const EXECUTION_EVIDENCE_PATTERN =
  /\b(process exited with code|assertionerror|traceback|command not found|permission denied|no such file or directory|segmentation fault)\b/iu;
const SHELL_SYNTAX_PATTERN =
  /\b(syntax error|unexpected token|unexpected eof|unterminated|unmatched ['"]|bad substitution|parse error)\b/iu;
const SHELL_RUNTIME_PREFIX_PATTERN =
  /(?:^|\n)\s*(?:\/bin\/(?:bash|sh)|bash|sh|zsh|dash|ksh|mksh|ash)(?::|\s+-[l]*c:)/iu;
const SCRIPT_COMPOSITION_PATTERN =
  /\b(command not found|syntax error)\b.*(?:[{}[\]]|\\"|",\s*"|"[a-z0-9_]+"\s*:)/i;
const COMMAND_NOT_FOUND_TOKEN_PATTERN = /:\s*([^\s:]+)\s*:\s*command not found\b/iu;

function collectFailureDetailText(details: unknown): string {
  const parts: string[] = [];

  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    parts.push(trimmed);
  };

  const visit = (value: unknown, depth: number) => {
    if (depth > 2) return;
    if (typeof value === "string") {
      push(value);
      return;
    }
    if (!isRecord(value)) return;

    push(value.message);
    push(value.error);
    push(value.reason);
    push(value.code);
    push(value.status);
    push(value.name);
    visit(value.result, depth + 1);
    visit(value.cause, depth + 1);
  };

  visit(details, 0);
  return parts.join("\n");
}

function looksLikeScriptCompositionToken(token: string): boolean {
  return !/^[A-Za-z0-9_./-]+$/u.test(token);
}

function classifyExecFailure(input: { details: unknown; outputText: string }): CommandFailureClass {
  const detailsText = collectFailureDetailText(input.details);
  const outputText = input.outputText;
  const detailsLooksLikeValidation = INVOCATION_VALIDATION_PATTERN.test(detailsText);
  const outputLooksLikeValidation = INVOCATION_VALIDATION_OUTPUT_PATTERN.test(outputText);
  const hasExecutionEvidence = EXECUTION_EVIDENCE_PATTERN.test(outputText);

  if ((detailsLooksLikeValidation || outputLooksLikeValidation) && !hasExecutionEvidence) {
    return "invocation_validation";
  }

  const shellSyntaxInOutput = SHELL_SYNTAX_PATTERN.test(outputText);
  const shellSyntaxStrongSignal =
    /syntax error near unexpected token|while looking for matching|unexpected EOF while looking for matching/iu.test(
      outputText,
    ) || SHELL_RUNTIME_PREFIX_PATTERN.test(outputText);
  if (shellSyntaxInOutput && shellSyntaxStrongSignal) {
    return "shell_syntax";
  }

  const token = COMMAND_NOT_FOUND_TOKEN_PATTERN.exec(outputText)?.[1];
  if (token && looksLikeScriptCompositionToken(token)) {
    return "script_composition";
  }
  if (SCRIPT_COMPOSITION_PATTERN.test(outputText)) {
    return "script_composition";
  }
  return "execution";
}

type TscDiagnosticEntry = {
  file: string;
  line: number;
  column: number;
  severity: string;
  code: string;
  message: string;
};

function coerceTscDiagnosticsFromDetails(details: unknown): {
  diagnostics: TscDiagnosticEntry[];
  truncated: boolean;
  diagnosticsCount: number | null;
  countsByCode: Record<string, number> | null;
} | null {
  if (!isRecord(details)) return null;
  if (!Array.isArray(details.diagnostics)) return null;

  const out: TscDiagnosticEntry[] = [];

  const truncated = Boolean(details.truncated);
  const diagnosticsCount =
    typeof details.diagnosticsCount === "number" && Number.isFinite(details.diagnosticsCount)
      ? Math.max(0, Math.trunc(details.diagnosticsCount))
      : null;
  const countsByCode = (() => {
    if (!isRecord(details.countsByCode)) return null;
    const entries = Object.entries(details.countsByCode);
    if (entries.length === 0) return null;
    const counts: Record<string, number> = {};
    for (const [key, value] of entries) {
      if (typeof key !== "string" || key.trim().length === 0) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      counts[key] = Math.max(0, Math.trunc(value));
    }
    return Object.keys(counts).length > 0 ? counts : null;
  })();

  for (const entry of details.diagnostics.slice(0, 80)) {
    if (!isRecord(entry)) continue;
    const file = typeof entry.file === "string" ? entry.file.trim() : "";
    const line = typeof entry.line === "number" ? entry.line : NaN;
    const column = typeof entry.column === "number" ? entry.column : NaN;
    const severity = typeof entry.severity === "string" ? entry.severity.trim() : "";
    const code = typeof entry.code === "string" ? entry.code.trim() : "";
    const message = typeof entry.message === "string" ? entry.message.trim() : "";

    if (!file || !Number.isFinite(line) || !Number.isFinite(column) || !code || !message) {
      continue;
    }

    out.push({
      file,
      line,
      column,
      severity: severity || "unknown",
      code,
      message: message.length > 400 ? `${message.slice(0, 397)}...` : message,
    });
  }

  return { diagnostics: out, truncated, diagnosticsCount, countsByCode };
}

export function extractEvidenceArtifacts(input: {
  toolName: string;
  args?: Record<string, unknown>;
  outputText: string;
  isError: boolean;
  details?: unknown;
}): EvidenceArtifact[] {
  const toolName = input.toolName.trim().toLowerCase();
  const artifacts: EvidenceArtifact[] = [];

  if (toolName === "exec" && input.isError) {
    const command = getCommand(input.args) ?? "";
    const exitCode = extractExitCode(input.details);
    const failureClass = classifyExecFailure({
      details: input.details,
      outputText: input.outputText,
    });

    const failingTests = uniqueLines(
      extractLines(input.outputText, /^\s*(?:FAIL|ERROR|✕|×)\b/i, 12),
      12,
    );
    const failedAssertions = uniqueLines(
      extractLines(
        input.outputText,
        /\b(AssertionError|Expected:|Received:|expected|received)\b/i,
        12,
      ),
      12,
    );
    const stackTrace = uniqueLines(extractLines(input.outputText, /^\s*at\s+.+$/m, 18), 18);

    artifacts.push({
      kind: "command_failure",
      tool: input.toolName,
      command,
      failureClass,
      exitCode: exitCode === null ? null : exitCode,
      failingTests,
      failedAssertions,
      stackTrace,
    });
  }

  if (toolName === "lsp_diagnostics") {
    const detailsRecord =
      input.details && typeof input.details === "object" && !Array.isArray(input.details)
        ? (input.details as Record<string, unknown>)
        : null;
    const detailsExitCode =
      detailsRecord &&
      typeof detailsRecord.exitCode === "number" &&
      Number.isFinite(detailsRecord.exitCode)
        ? Math.trunc(detailsRecord.exitCode)
        : null;
    const detailsReason =
      detailsRecord && typeof detailsRecord.reason === "string" ? detailsRecord.reason : null;

    if (
      detailsReason === "diagnostics_scope_mismatch" &&
      detailsExitCode !== null &&
      detailsExitCode !== 0
    ) {
      const target = getDiagnosticTarget(input.args);
      artifacts.push({
        kind: "tsc_scope_mismatch",
        tool: input.toolName,
        filePath: target.filePath ?? null,
        severityFilter: target.severityFilter ?? null,
        exitCode: detailsExitCode,
      });
      return artifacts;
    }

    const outputLower = input.outputText.toLowerCase().trimStart();
    if (outputLower.includes("no diagnostics found")) {
      return artifacts;
    }
    if (outputLower.startsWith("error:")) {
      return artifacts;
    }

    const target = getDiagnosticTarget(input.args);
    const structured = coerceTscDiagnosticsFromDetails(input.details);
    let diagnostics: TscDiagnosticEntry[] = [];
    let truncated = false;
    let diagnosticsCount: number | null = null;
    let countsByCode: Record<string, number> = {};
    if (structured) {
      diagnostics = structured.diagnostics;
      truncated = structured.truncated;
      diagnosticsCount = structured.diagnosticsCount;
      countsByCode = structured.countsByCode ?? {};
    } else {
      const parsed = parseTscDiagnostics(input.outputText, 80);
      diagnostics = parsed.diagnostics;
      truncated = parsed.truncated;
      diagnosticsCount = null;
    }
    if (diagnostics.length === 0) {
      return artifacts;
    }

    if (Object.keys(countsByCode).length === 0) {
      for (const diagnostic of diagnostics) {
        countsByCode[diagnostic.code] = (countsByCode[diagnostic.code] ?? 0) + 1;
      }
    }

    const count = diagnosticsCount ?? diagnostics.length;

    artifacts.push({
      kind: "tsc_diagnostics",
      tool: input.toolName,
      filePath: target.filePath ?? null,
      severityFilter: target.severityFilter ?? null,
      truncated,
      count,
      codes: Object.keys(countsByCode),
      countsByCode,
      diagnostics: diagnostics.slice(0, 24).map(
        (diagnostic) =>
          ({
            file: diagnostic.file,
            line: diagnostic.line,
            column: diagnostic.column,
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
          }) as Record<string, JsonValue>,
      ),
    });
  }

  return artifacts;
}
