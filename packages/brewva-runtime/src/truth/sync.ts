import { relative, resolve } from "node:path";
import {
  extractEvidenceArtifacts,
  type CommandFailureClass,
  type EvidenceArtifact,
} from "../evidence/artifacts.js";
import { parseTscDiagnostics } from "../evidence/tsc.js";
import { redactSecrets } from "../security/redact.js";
import type { TaskState, TruthFact, TruthFactSeverity, TruthState } from "../types.js";
import { sha256 } from "../utils/hash.js";
import { normalizeToolName } from "../utils/tool-name.js";
import {
  isToolResultFail,
  isToolResultInconclusive,
  isToolResultPass,
  type ToolResultVerdict,
} from "../utils/tool-result.js";

export interface TruthSyncContext {
  cwd: string;
  getTaskState(sessionId: string): TaskState;
  getTruthState(sessionId: string): TruthState;
  upsertTruthFact(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
    },
  ): { ok: boolean; fact?: TruthFact };
  resolveTruthFact(sessionId: string, truthFactId: string): { ok: boolean };
  recordTaskBlocker(
    sessionId: string,
    input: { id: string; message: string; source?: string; truthFactId?: string },
  ): { ok: boolean };
  resolveTaskBlocker(sessionId: string, blockerId: string): { ok: boolean };
}

function extractShellCommandFromArgs(args: Record<string, unknown>): string | undefined {
  const candidate = args.command ?? args.cmd ?? args.script;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const COMMAND_PREFIX_TOKENS = new Set(["sudo", "command", "time"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE_PREFIXES = [
  "--config-env=",
  "--exec-path=",
  "--git-dir=",
  "--namespace=",
  "--super-prefix=",
  "--work-tree=",
];

function normalizeCommandToken(token: string): string {
  const trimmed = token.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed) return "";
  const withoutWindowsPrefix = trimmed.replace(/^[A-Za-z]:\\/u, "");
  const segments = withoutWindowsPrefix.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

function resolveGitSubcommand(tokens: string[], primaryIndex: number): string | undefined {
  for (let index = primaryIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      const next = tokens[index + 1];
      return next ? normalizeCommandToken(next) : undefined;
    }

    if (token.startsWith("-")) {
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => token.startsWith(prefix))) {
        continue;
      }

      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
        index += 1;
      }
      continue;
    }

    return normalizeCommandToken(token);
  }

  return undefined;
}

function resolvePrimaryCommand(command: string): { command: string; subcommand?: string } | null {
  const tokens = command
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  let primaryIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token)) continue;

    const normalized = normalizeCommandToken(token);
    if (!normalized) continue;
    if (normalized === "env") continue;
    if (COMMAND_PREFIX_TOKENS.has(normalized)) continue;
    primaryIndex = index;
    break;
  }

  if (primaryIndex < 0) return null;
  const primary = normalizeCommandToken(tokens[primaryIndex]!);
  if (!primary) return null;

  if (primary === "git") {
    const subcommand = resolveGitSubcommand(tokens, primaryIndex);
    return subcommand ? { command: primary, subcommand } : { command: primary };
  }

  for (let index = primaryIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("-")) continue;
    const subcommand = normalizeCommandToken(token);
    if (!subcommand) continue;
    return { command: primary, subcommand };
  }

  return { command: primary };
}

function extractExitCodeFromOutput(outputText: string): number | null {
  const match = /process exited with code\s+(-?\d+)\.?/i.exec(outputText);
  if (!match) return null;
  const exitCode = Number(match[1]);
  return Number.isFinite(exitCode) ? exitCode : null;
}

function isBenignSearchNoMatchFailure(input: {
  command: string;
  exitCode: number | null;
}): boolean {
  if (input.exitCode !== 1) return false;
  const resolved = resolvePrimaryCommand(input.command);
  if (!resolved) return false;

  const isSearchCommand =
    resolved.command === "rg" ||
    resolved.command === "grep" ||
    resolved.command === "findstr" ||
    (resolved.command === "git" && resolved.subcommand === "grep");
  return isSearchCommand;
}

function resolveCommandFailureFact(ctx: TruthSyncContext, sessionId: string, factId: string): void {
  const truthState = ctx.getTruthState(sessionId);
  const active = truthState.facts.find((fact) => fact.id === factId && fact.status === "active");
  if (active) {
    ctx.resolveTruthFact(sessionId, factId);
  }
  resolveTruthBackedBlocker(ctx, sessionId, factId);
}

function resolveCommandFailureClass(failure: EvidenceArtifact | undefined): CommandFailureClass {
  const value = failure?.failureClass;
  if (
    value === "execution" ||
    value === "invocation_validation" ||
    value === "shell_syntax" ||
    value === "script_composition"
  ) {
    return value;
  }
  return "execution";
}

function truthFactIdForCommand(command: string): string {
  const normalized = redactSecrets(command).trim().toLowerCase();
  const digest = sha256(normalized).slice(0, 16);
  return `truth:command:${digest}`;
}

function normalizeTruthFilePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath).replace(/\\/g, "/");
}

function displayFilePath(cwd: string, filePath: string): string {
  const normalized = resolve(cwd, filePath);
  const rel = relative(cwd, normalized);
  if (!rel || rel.startsWith("..")) return filePath;
  return rel;
}

function truthFactPrefixForDiagnosticFile(cwd: string, filePath: string): string {
  const digest = sha256(normalizeTruthFilePath(cwd, filePath)).slice(0, 16);
  return `truth:diagnostic:${digest}:`;
}

function truthFactIdForDiagnostic(cwd: string, filePath: string, code: string): string {
  const prefix = truthFactPrefixForDiagnosticFile(cwd, filePath);
  const normalizedCode = code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return `${prefix}${normalizedCode || "unknown"}`;
}

function redactAndClamp(text: string, maxChars: number): string {
  const redacted = redactSecrets(text);
  const trimmed = redacted.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const keep = Math.max(0, Math.floor(maxChars) - 3);
  return `${trimmed.slice(0, keep)}...`;
}

function coerceEvidenceArtifacts(raw: unknown): EvidenceArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceArtifact[] = [];
  for (const entry of raw.slice(0, 24)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const kind = (entry as { kind?: unknown }).kind;
    if (typeof kind !== "string" || kind.trim().length === 0) continue;
    out.push(entry as EvidenceArtifact);
  }
  return out;
}

function dedupeArtifacts(artifacts: EvidenceArtifact[]): EvidenceArtifact[] {
  const out: EvidenceArtifact[] = [];
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    let key = "";
    try {
      key = sha256(JSON.stringify(artifact)).slice(0, 16);
    } catch {
      key = `fallback_${Math.random().toString(36).slice(2, 10)}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

function recordTruthBackedBlocker(
  ctx: TruthSyncContext,
  sessionId: string,
  input: {
    blockerId: string;
    truthFactId: string;
    message: string;
    source: string;
  },
): void {
  const current = ctx.getTaskState(sessionId);
  const existing = current.blockers.find((blocker) => blocker.id === input.blockerId);
  if (
    existing &&
    existing.message === input.message &&
    (existing.source ?? "") === input.source &&
    (existing.truthFactId ?? "") === input.truthFactId
  ) {
    return;
  }
  ctx.recordTaskBlocker(sessionId, {
    id: input.blockerId,
    message: input.message,
    source: input.source,
    truthFactId: input.truthFactId,
  });
}

function resolveTruthBackedBlocker(
  ctx: TruthSyncContext,
  sessionId: string,
  blockerId: string,
): void {
  const current = ctx.getTaskState(sessionId);
  if (!current.blockers.some((blocker) => blocker.id === blockerId)) {
    return;
  }
  ctx.resolveTaskBlocker(sessionId, blockerId);
}

export interface TruthSyncInput {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  verdict: ToolResultVerdict;
  ledgerRow: {
    id: string;
    outputHash: string;
    argsSummary: string;
    outputSummary: string;
  };
  metadata?: Record<string, unknown>;
}

type ObservabilityAssertionSpec = {
  types: string[];
  where: Record<string, string | number | boolean | null>;
  metric: string;
  aggregation: string;
  operator: string;
  threshold: number;
  windowMinutes: number | null;
  minSamples: number;
};

type ObservabilityAssertionRecord = {
  verdict: "pass" | "fail" | "inconclusive";
  severity: TruthFactSeverity;
  observedValue: number | null;
  sampleSize: number;
  queryRef: string | null;
  spec: ObservabilityAssertionSpec;
};

function normalizeObservabilityAssertionSpec(
  value: unknown,
): ObservabilityAssertionSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.metric !== "string" || record.metric.trim().length === 0) {
    return undefined;
  }
  if (typeof record.aggregation !== "string" || record.aggregation.trim().length === 0) {
    return undefined;
  }
  if (typeof record.operator !== "string" || record.operator.trim().length === 0) {
    return undefined;
  }
  if (typeof record.threshold !== "number" || !Number.isFinite(record.threshold)) {
    return undefined;
  }

  const types = Array.isArray(record.types)
    ? record.types
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .toSorted()
    : [];
  const whereInput =
    record.where && typeof record.where === "object" && !Array.isArray(record.where)
      ? (record.where as Record<string, unknown>)
      : {};
  const where: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(whereInput).toSorted()) {
    const raw = whereInput[key];
    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw === null
    ) {
      where[key] = raw;
    }
  }

  const windowMinutes =
    typeof record.windowMinutes === "number" && Number.isFinite(record.windowMinutes)
      ? Math.max(1, Math.floor(record.windowMinutes))
      : null;
  const minSamples =
    typeof record.minSamples === "number" && Number.isFinite(record.minSamples)
      ? Math.max(1, Math.floor(record.minSamples))
      : 1;

  return {
    types,
    where,
    metric: record.metric.trim(),
    aggregation: record.aggregation.trim(),
    operator: record.operator.trim(),
    threshold: record.threshold,
    windowMinutes,
    minSamples,
  };
}

function normalizeObservabilityAssertion(
  input: TruthSyncInput,
): ObservabilityAssertionRecord | undefined {
  if (input.toolName !== "obs_slo_assert") {
    return undefined;
  }

  const details =
    input.metadata?.details &&
    typeof input.metadata.details === "object" &&
    !Array.isArray(input.metadata.details)
      ? (input.metadata.details as Record<string, unknown>)
      : undefined;
  if (!details) {
    return undefined;
  }

  const verdict = details.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return undefined;
  }

  const assertion =
    details.observabilityAssertion &&
    typeof details.observabilityAssertion === "object" &&
    !Array.isArray(details.observabilityAssertion)
      ? (details.observabilityAssertion as Record<string, unknown>)
      : undefined;
  if (!assertion || assertion.kind !== "slo_assert") {
    return undefined;
  }

  const spec = normalizeObservabilityAssertionSpec(assertion.spec);
  if (!spec) {
    return undefined;
  }

  const severityRaw = assertion.severity;
  const severity: TruthFactSeverity =
    severityRaw === "info" || severityRaw === "warn" || severityRaw === "error"
      ? severityRaw
      : "warn";
  const observedValue =
    typeof assertion.observedValue === "number" && Number.isFinite(assertion.observedValue)
      ? assertion.observedValue
      : null;
  const sampleSize =
    typeof assertion.sampleSize === "number" && Number.isFinite(assertion.sampleSize)
      ? Math.max(0, Math.floor(assertion.sampleSize))
      : 0;
  const queryRef =
    typeof assertion.queryRef === "string" && assertion.queryRef.trim().length > 0
      ? assertion.queryRef.trim()
      : null;

  return {
    verdict,
    severity,
    observedValue,
    sampleSize,
    queryRef,
    spec,
  };
}

function observabilityAssertionFactId(assertion: ObservabilityAssertionRecord): string {
  const digest = sha256(JSON.stringify(assertion.spec)).slice(0, 16);
  return `truth:observability:${digest}`;
}

function syncObservabilityAssertionTruth(ctx: TruthSyncContext, input: TruthSyncInput): void {
  const assertion = normalizeObservabilityAssertion(input);
  if (!assertion) {
    return;
  }

  const factId = observabilityAssertionFactId(assertion);
  if (assertion.verdict === "inconclusive") {
    return;
  }

  if (assertion.verdict === "pass") {
    const truthState = ctx.getTruthState(input.sessionId);
    const active = truthState.facts.find((fact) => fact.id === factId && fact.status === "active");
    if (active) {
      ctx.resolveTruthFact(input.sessionId, factId);
    }
    resolveTruthBackedBlocker(ctx, input.sessionId, factId);
    return;
  }

  const thresholdText = Number.isInteger(assertion.spec.threshold)
    ? String(assertion.spec.threshold)
    : assertion.spec.threshold.toFixed(2);
  const observedText =
    assertion.observedValue === null
      ? "unknown"
      : Number.isInteger(assertion.observedValue)
        ? String(assertion.observedValue)
        : assertion.observedValue.toFixed(2);
  const summary = `observability SLO violated: ${assertion.spec.metric} ${assertion.spec.aggregation} ${assertion.spec.operator} ${thresholdText} (observed=${observedText})`;

  ctx.upsertTruthFact(input.sessionId, {
    id: factId,
    kind: "observability_slo_violation",
    severity: assertion.severity,
    summary,
    evidenceIds: [input.ledgerRow.id],
    details: {
      metric: assertion.spec.metric,
      aggregation: assertion.spec.aggregation,
      operator: assertion.spec.operator,
      threshold: assertion.spec.threshold,
      observedValue: assertion.observedValue,
      sampleSize: assertion.sampleSize,
      windowMinutes: assertion.spec.windowMinutes,
      queryRef: assertion.queryRef,
      types: assertion.spec.types,
      where: assertion.spec.where,
      minSamples: assertion.spec.minSamples,
      argsSummary: input.ledgerRow.argsSummary,
      outputSummary: input.ledgerRow.outputSummary,
    },
  });

  recordTruthBackedBlocker(ctx, input.sessionId, {
    blockerId: factId,
    truthFactId: factId,
    message: summary,
    source: "truth_extractor",
  });
}

export function syncTruthFromToolResult(ctx: TruthSyncContext, input: TruthSyncInput): void {
  const normalizedTool = normalizeToolName(input.toolName);

  const metadataArtifacts = coerceEvidenceArtifacts(input.metadata?.artifacts);
  const extractedArtifacts = extractEvidenceArtifacts({
    toolName: input.toolName,
    args: input.args,
    outputText: input.outputText,
    isError: isToolResultFail(input.verdict),
    details: input.metadata?.details,
  });
  const artifacts = dedupeArtifacts([...metadataArtifacts, ...extractedArtifacts]);

  if (normalizedTool === "exec") {
    syncExecTruth(ctx, input, artifacts);
    return;
  }

  if (normalizedTool === "lsp_diagnostics") {
    syncDiagnosticsTruth(ctx, input);
    return;
  }

  if (normalizedTool === "obs_slo_assert") {
    syncObservabilityAssertionTruth(ctx, input);
  }
}

function syncExecTruth(
  ctx: TruthSyncContext,
  input: TruthSyncInput,
  artifacts: EvidenceArtifact[],
): void {
  const commandFromArgs = extractShellCommandFromArgs(input.args);
  const commandFromArtifact = artifacts.find(
    (artifact) => artifact.kind === "command_failure",
  )?.command;
  const command =
    typeof commandFromArtifact === "string" && commandFromArtifact.trim().length > 0
      ? commandFromArtifact.trim()
      : commandFromArgs;
  if (!command) return;

  const commandSummary = redactAndClamp(command, 160);
  const commandDetail = redactAndClamp(command, 480);
  const factId = truthFactIdForCommand(command);

  if (isToolResultInconclusive(input.verdict)) {
    return;
  }

  if (isToolResultPass(input.verdict)) {
    resolveCommandFailureFact(ctx, input.sessionId, factId);
    return;
  }

  const failure = artifacts.find((artifact) => artifact.kind === "command_failure");
  const exitCodeRaw = failure?.exitCode;
  const artifactExitCode =
    typeof exitCodeRaw === "number" && Number.isFinite(exitCodeRaw) ? exitCodeRaw : null;
  const outputExitCode = extractExitCodeFromOutput(input.outputText);
  const exitCode = artifactExitCode ?? outputExitCode;
  const failureClass = resolveCommandFailureClass(failure);

  if (
    isBenignSearchNoMatchFailure({
      command,
      exitCode,
    })
  ) {
    resolveCommandFailureFact(ctx, input.sessionId, factId);
    return;
  }

  if (failureClass !== "execution") {
    resolveCommandFailureFact(ctx, input.sessionId, factId);
    return;
  }

  const summary =
    exitCode === null
      ? `command failed: ${commandSummary}`
      : `command failed: ${commandSummary} (exitCode=${exitCode})`;

  ctx.upsertTruthFact(input.sessionId, {
    id: factId,
    kind: "command_failure",
    severity: "error",
    summary,
    evidenceIds: [input.ledgerRow.id],
    details: {
      tool: input.toolName,
      command: commandDetail,
      failureClass,
      exitCode,
      outputHash: input.ledgerRow.outputHash,
      argsSummary: input.ledgerRow.argsSummary,
      outputSummary: input.ledgerRow.outputSummary,
      failingTests: Array.isArray(failure?.failingTests) ? failure?.failingTests : [],
      failedAssertions: Array.isArray(failure?.failedAssertions) ? failure?.failedAssertions : [],
      stackTrace: Array.isArray(failure?.stackTrace) ? failure?.stackTrace : [],
    },
  });

  recordTruthBackedBlocker(ctx, input.sessionId, {
    blockerId: factId,
    truthFactId: factId,
    message: summary,
    source: "truth_extractor",
  });
}

function syncDiagnosticsTruth(ctx: TruthSyncContext, input: TruthSyncInput): void {
  const rawSeverity = input.args.severity;
  const severityFilter = typeof rawSeverity === "string" ? rawSeverity.trim() : "";
  const unfiltered = severityFilter === "" || severityFilter.toLowerCase() === "all";

  const rawFilePath = input.args.filePath;
  const targetFilePath = typeof rawFilePath === "string" ? rawFilePath.trim() : "";
  if (!targetFilePath) return;
  const targetFileKey = normalizeTruthFilePath(ctx.cwd, targetFilePath);
  const targetPrefix = truthFactPrefixForDiagnosticFile(ctx.cwd, targetFileKey);

  const trimmedOutput = input.outputText.trim();
  const outputLower = trimmedOutput.toLowerCase();
  const detailsRecord =
    input.metadata?.details &&
    typeof input.metadata.details === "object" &&
    !Array.isArray(input.metadata.details)
      ? (input.metadata.details as Record<string, unknown>)
      : null;
  const detailsExitCode =
    detailsRecord &&
    typeof detailsRecord.exitCode === "number" &&
    Number.isFinite(detailsRecord.exitCode)
      ? Math.trunc(detailsRecord.exitCode)
      : null;
  const detailsStatus =
    detailsRecord && typeof detailsRecord.status === "string" ? detailsRecord.status : null;
  const scopeMismatch =
    detailsRecord?.reason === "diagnostics_scope_mismatch" || detailsStatus === "unavailable";

  if (
    unfiltered &&
    outputLower.includes("no diagnostics found") &&
    !scopeMismatch &&
    (detailsExitCode === null || detailsExitCode === 0)
  ) {
    const truthState = ctx.getTruthState(input.sessionId);
    for (const fact of truthState.facts) {
      if (fact.status !== "active") continue;
      if (!fact.id.startsWith(targetPrefix)) continue;
      ctx.resolveTruthFact(input.sessionId, fact.id);
      resolveTruthBackedBlocker(ctx, input.sessionId, fact.id);
    }
    return;
  }

  if (outputLower.startsWith("error:") || trimmedOutput.length === 0) {
    return;
  }

  type ToolDiagnostic = {
    file: string;
    line: number;
    column: number;
    severity: string;
    code: string;
    message: string;
  };

  const detailsDiagnostics = (() => {
    const details = input.metadata?.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return null;
    }
    const record = details as Record<string, unknown>;
    if (!Array.isArray(record.diagnostics)) return null;

    const out: ToolDiagnostic[] = [];

    for (const entry of record.diagnostics.slice(0, 240)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const diag = entry as Record<string, unknown>;
      const file = typeof diag.file === "string" ? diag.file.trim() : "";
      const line = typeof diag.line === "number" ? diag.line : NaN;
      const column = typeof diag.column === "number" ? diag.column : NaN;
      const severity = typeof diag.severity === "string" ? diag.severity.trim() : "";
      const code = typeof diag.code === "string" ? diag.code.trim() : "";
      const message = typeof diag.message === "string" ? diag.message.trim() : "";

      if (!file || !Number.isFinite(line) || !Number.isFinite(column) || !code || !message) {
        continue;
      }
      out.push({ file, line, column, severity: severity || "unknown", code, message });
    }

    return {
      diagnostics: out,
      truncated: Boolean(record.truncated),
    };
  })();

  let diagnostics: ToolDiagnostic[] = [];
  let diagnosticsTruncated = false;
  if (detailsDiagnostics) {
    diagnostics = detailsDiagnostics.diagnostics;
    diagnosticsTruncated = detailsDiagnostics.truncated;
  } else {
    const parsed = parseTscDiagnostics(input.outputText, 240);
    diagnostics = parsed.diagnostics;
    diagnosticsTruncated = parsed.truncated;
  }

  diagnostics = diagnostics.filter(
    (diagnostic) => normalizeTruthFilePath(ctx.cwd, diagnostic.file) === targetFileKey,
  );
  if (diagnostics.length === 0) {
    return;
  }

  type TruthDiagnosticSample = {
    line: number;
    column: number;
    message: string;
  };
  type CodeAggregate = {
    count: number;
    severity: TruthFactSeverity;
    samples: TruthDiagnosticSample[];
  };

  const aggregates = new Map<string, CodeAggregate>();
  for (const diagnostic of diagnostics) {
    const code = diagnostic.code.trim();
    if (!code) continue;

    const truthSeverity: TruthFactSeverity =
      diagnostic.severity === "error"
        ? "error"
        : diagnostic.severity === "warning"
          ? "warn"
          : "info";

    const bucket = aggregates.get(code) ?? {
      count: 0,
      severity: truthSeverity,
      samples: [],
    };

    bucket.count += 1;
    if (bucket.severity !== "error" && truthSeverity === "error") {
      bucket.severity = "error";
    }
    if (bucket.severity === "info" && truthSeverity === "warn") {
      bucket.severity = "warn";
    }

    if (bucket.samples.length < 3) {
      bucket.samples.push({
        line: diagnostic.line,
        column: diagnostic.column,
        message: diagnostic.message,
      });
    }

    aggregates.set(code, bucket);
  }

  if (aggregates.size === 0) return;

  const fileDisplay = displayFilePath(ctx.cwd, targetFileKey);
  const currentFactIds = new Set<string>();

  for (const [code, aggregate] of aggregates.entries()) {
    const factId = truthFactIdForDiagnostic(ctx.cwd, targetFileKey, code);
    currentFactIds.add(factId);

    const summary = `diagnostic: ${fileDisplay} ${code} x${aggregate.count}`;

    ctx.upsertTruthFact(input.sessionId, {
      id: factId,
      kind: "diagnostic",
      severity: aggregate.severity,
      summary,
      evidenceIds: [input.ledgerRow.id],
      details: {
        tool: input.toolName,
        compiler: "tsc",
        severityFilter: severityFilter || null,
        file: fileDisplay,
        code,
        count: aggregate.count,
        samples: aggregate.samples,
        outputHash: input.ledgerRow.outputHash,
        argsSummary: input.ledgerRow.argsSummary,
        outputSummary: input.ledgerRow.outputSummary,
        truncated: diagnosticsTruncated,
      },
    });

    recordTruthBackedBlocker(ctx, input.sessionId, {
      blockerId: factId,
      truthFactId: factId,
      message: summary,
      source: "truth_extractor",
    });
  }

  if (unfiltered) {
    const truthState = ctx.getTruthState(input.sessionId);
    for (const fact of truthState.facts) {
      if (fact.status !== "active") continue;
      if (!fact.id.startsWith(targetPrefix)) continue;
      if (currentFactIds.has(fact.id)) continue;
      ctx.resolveTruthFact(input.sessionId, fact.id);
      resolveTruthBackedBlocker(ctx, input.sessionId, fact.id);
    }
  }
}
