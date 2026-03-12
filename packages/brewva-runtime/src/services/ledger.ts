import { TOOL_RESULT_RECORDED_EVENT_TYPE } from "../events/event-types.js";
import { extractEvidenceArtifacts, type CommandFailureClass } from "../evidence/artifacts.js";
import { buildLedgerDigest } from "../ledger/digest.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import { formatLedgerRows } from "../ledger/query.js";
import {
  readToolFailureContextMetadata,
  withToolFailureContextMetadata,
} from "../ledger/tool-failure-context.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { BrewvaConfig, EvidenceLedgerRow, EvidenceQuery, SkillDocument } from "../types.js";
import type { JsonValue } from "../utils/json.js";
import { normalizeToolName } from "../utils/tool-name.js";
import {
  isToolResultFail,
  resolveToolResultVerdict,
  type ToolResultVerdict,
} from "../utils/tool-result.js";
import { buildVerificationToolResultProjectionPayload } from "../verification/projector-payloads.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

const LEDGER_DIGEST_WINDOW = 12;
const LEDGER_MAX_DIGEST_TOKENS = 1200;
const TRUTH_PROJECTOR_TOOLS = new Set(["exec", "lsp_diagnostics", "obs_slo_assert"]);

function normalizeFailureClass(value: unknown): CommandFailureClass | undefined {
  if (
    value === "execution" ||
    value === "invocation_validation" ||
    value === "shell_syntax" ||
    value === "script_composition"
  ) {
    return value;
  }
  return undefined;
}

function resolveToolFailureClass(input: {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  verdict: ToolResultVerdict;
  metadata: Record<string, unknown> | undefined;
}): CommandFailureClass | undefined {
  if (!isToolResultFail(input.verdict)) return undefined;

  const artifacts = extractEvidenceArtifacts({
    toolName: input.toolName,
    args: input.args,
    outputText: input.outputText,
    isError: true,
    details: input.metadata?.details,
  });
  const commandFailure = artifacts.find((artifact) => artifact.kind === "command_failure");
  return normalizeFailureClass(commandFailure?.failureClass);
}

export interface LedgerServiceOptions {
  config: RuntimeKernelContext["config"];
  evidenceLedger: RuntimeKernelContext["evidenceLedger"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
}

function buildTruthProjectionPayload(input: {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  verdict: ToolResultVerdict;
  metadata?: Record<string, unknown>;
  ledgerRow: {
    id: string;
    outputHash: string;
    argsSummary: string;
    outputSummary: string;
  };
}): Record<string, unknown> | null {
  const normalizedToolName = normalizeToolName(input.toolName);
  if (!normalizedToolName || !TRUTH_PROJECTOR_TOOLS.has(normalizedToolName)) {
    return null;
  }

  const details =
    input.metadata &&
    typeof input.metadata === "object" &&
    "details" in input.metadata &&
    input.metadata.details &&
    typeof input.metadata.details === "object"
      ? (input.metadata.details as Record<string, unknown>)
      : undefined;
  const artifacts = Array.isArray(input.metadata?.artifacts) ? input.metadata.artifacts : undefined;

  return {
    toolName: normalizedToolName,
    args: input.args,
    outputText: input.outputText,
    verdict: input.verdict,
    ledgerRow: input.ledgerRow,
    metadata:
      details || artifacts
        ? {
            details,
            artifacts,
          }
        : undefined,
  };
}

export class LedgerService {
  private readonly config: BrewvaConfig;
  private readonly ledger: EvidenceLedger;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;

  constructor(options: LedgerServiceOptions) {
    this.config = options.config;
    this.ledger = options.evidenceLedger;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  recordInfrastructureRow(input: {
    sessionId: string;
    tool: string;
    argsSummary: string;
    outputSummary: string;
    fullOutput?: string;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
    turn?: number;
    skill?: string | null;
  }): string {
    const turn = input.turn ?? this.getCurrentTurn(input.sessionId);
    const activeSkill = this.getActiveSkill(input.sessionId);
    const ledgerRow = this.ledger.append({
      sessionId: input.sessionId,
      turn,
      skill: input.skill ?? activeSkill?.name,
      tool: input.tool,
      argsSummary: input.argsSummary,
      outputSummary: input.outputSummary,
      fullOutput: input.fullOutput,
      verdict: input.verdict ?? "inconclusive",
      metadata: input.metadata,
    });

    // Infrastructure rows are part of the evidence chain, but they intentionally do not
    // participate in truth sync or verification evidence classification.
    this.maybeCompactLedger(input.sessionId, turn);
    return ledgerRow.id;
  }

  recordToolResult(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    channelSuccess: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }): string {
    const turn = this.getCurrentTurn(input.sessionId);
    const activeSkill = this.getActiveSkill(input.sessionId);
    const verdict = resolveToolResultVerdict({
      verdict: input.verdict,
      channelSuccess: input.channelSuccess,
    });
    const failureClass = resolveToolFailureClass({
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      verdict,
      metadata: input.metadata,
    });
    const metadata = withToolFailureContextMetadata(input.metadata, {
      verdict,
      args: input.args,
      outputText: input.outputText,
      failureClass,
    });

    const ledgerRow = this.ledger.append({
      sessionId: input.sessionId,
      turn,
      skill: activeSkill?.name,
      tool: input.toolName,
      argsSummary: JSON.stringify(input.args).slice(0, 400),
      outputSummary: input.outputText.slice(0, 500),
      fullOutput: input.outputText,
      verdict,
      metadata,
    });

    const observedAt = Date.now();
    const outputObservation =
      metadata &&
      typeof metadata === "object" &&
      "outputObservation" in metadata &&
      metadata.outputObservation &&
      typeof metadata.outputObservation === "object"
        ? (metadata.outputObservation as Record<string, unknown>)
        : null;
    const outputDistillation =
      metadata &&
      typeof metadata === "object" &&
      "outputDistillation" in metadata &&
      metadata.outputDistillation &&
      typeof metadata.outputDistillation === "object"
        ? (metadata.outputDistillation as Record<string, unknown>)
        : null;
    const outputArtifact =
      metadata &&
      typeof metadata === "object" &&
      "outputArtifact" in metadata &&
      metadata.outputArtifact &&
      typeof metadata.outputArtifact === "object"
        ? (metadata.outputArtifact as Record<string, unknown>)
        : null;
    const toolFailureContext = readToolFailureContextMetadata(
      metadata as Record<string, JsonValue> | undefined,
    );
    this.recordEvent({
      sessionId: input.sessionId,
      type: TOOL_RESULT_RECORDED_EVENT_TYPE,
      turn,
      payload: {
        toolName: input.toolName,
        verdict,
        channelSuccess: input.channelSuccess,
        ledgerId: ledgerRow.id,
        outputObservation,
        outputArtifact,
        outputDistillation,
        truthProjection: buildTruthProjectionPayload({
          toolName: input.toolName,
          args: input.args,
          outputText: input.outputText,
          verdict,
          metadata,
          ledgerRow: {
            id: ledgerRow.id,
            outputHash: ledgerRow.outputHash,
            argsSummary: ledgerRow.argsSummary,
            outputSummary: ledgerRow.outputSummary,
          },
        }),
        verificationProjection: buildVerificationToolResultProjectionPayload({
          now: observedAt,
          toolName: input.toolName,
          args: input.args,
          outputText: input.outputText,
          verdict,
          metadata,
          ledgerId: ledgerRow.id,
          outputSummary: ledgerRow.outputSummary,
        }),
        failureClass: failureClass ?? null,
        failureContext: toolFailureContext
          ? {
              args: toolFailureContext.args,
              outputText: toolFailureContext.outputText,
              failureClass: toolFailureContext.failureClass ?? null,
              turn,
            }
          : null,
      },
    });
    this.maybeCompactLedger(input.sessionId, turn);
    return ledgerRow.id;
  }

  getLedgerDigest(sessionId: string): string {
    const rows = this.ledger.list(sessionId);
    const digest = buildLedgerDigest(
      sessionId,
      rows,
      LEDGER_DIGEST_WINDOW,
      LEDGER_MAX_DIGEST_TOKENS,
    );

    const lines: string[] = [
      `[EvidenceDigest session=${sessionId}]`,
      `count=${digest.summary.total} pass=${digest.summary.pass} fail=${digest.summary.fail} inconclusive=${digest.summary.inconclusive}`,
    ];
    for (const row of digest.records) {
      lines.push(`- ${row.tool}(${row.verdict}) ${row.argsSummary}`);
    }
    return lines.join("\n");
  }

  queryLedger(sessionId: string, query: EvidenceQuery): string {
    const rows = this.ledger.query(sessionId, query);
    return formatLedgerRows(rows);
  }

  listLedgerRows(sessionId?: string): EvidenceLedgerRow[] {
    return this.ledger.list(sessionId);
  }

  verifyLedgerChain(sessionId: string): { valid: boolean; reason?: string } {
    return this.ledger.verifyChain(sessionId);
  }

  getLedgerPath(): string {
    return this.ledger.path;
  }

  private maybeCompactLedger(sessionId: string, turn: number): void {
    const state = this.sessionState.getCell(sessionId);
    const every = Math.max(0, Math.trunc(this.config.ledger.checkpointEveryTurns));
    if (every <= 0) return;
    if (turn <= 0) return;
    if (turn % every !== 0) return;
    if (state.lastLedgerCompactionTurn === turn) {
      return;
    }

    const keepLast = Math.max(2, Math.min(LEDGER_DIGEST_WINDOW, every - 1));
    const result = this.ledger.compactSession(sessionId, {
      keepLast,
      reason: `turn-${turn}`,
    });
    if (!result) return;
    state.lastLedgerCompactionTurn = turn;
    this.recordEvent({
      sessionId,
      type: "ledger_compacted",
      turn,
      payload: {
        compacted: result.compacted,
        kept: result.kept,
        checkpointId: result.checkpointId,
      },
    });
  }
}
