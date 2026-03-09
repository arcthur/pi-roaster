import { TOOL_RESULT_RECORDED_EVENT_TYPE } from "../events/event-types.js";
import { extractEvidenceArtifacts, type CommandFailureClass } from "../evidence/artifacts.js";
import { buildLedgerDigest } from "../ledger/digest.js";
import type { EvidenceLedger } from "../ledger/evidence-ledger.js";
import { formatLedgerRows } from "../ledger/query.js";
import {
  readToolFailureContextMetadata,
  withToolFailureContextMetadata,
} from "../ledger/tool-failure-context.js";
import { syncTruthFromToolResult } from "../truth/sync.js";
import type {
  BrewvaConfig,
  EvidenceLedgerRow,
  EvidenceQuery,
  SkillDocument,
  TaskState,
  TruthFact,
  TruthFactSeverity,
  TruthFactStatus,
  TruthState,
} from "../types.js";
import type { JsonValue } from "../utils/json.js";
import {
  isToolResultFail,
  resolveToolResultVerdict,
  type ToolResultVerdict,
} from "../utils/tool-result.js";
import { classifyEvidence } from "../verification/classifier.js";
import type { VerificationGate } from "../verification/gate.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

const LEDGER_DIGEST_WINDOW = 12;
const LEDGER_MAX_DIGEST_TOKENS = 1200;

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
  cwd: string;
  config: BrewvaConfig;
  ledger: EvidenceLedger;
  verification: VerificationGate;
  sessionState: RuntimeSessionStateStore;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  upsertTruthFact: RuntimeCallback<
    [
      sessionId: string,
      input: {
        id: string;
        kind: string;
        severity: TruthFactSeverity;
        summary: string;
        details?: Record<string, unknown>;
        evidenceIds?: string[];
        status?: TruthFactStatus;
      },
    ],
    { ok: boolean; fact?: TruthFact; error?: string }
  >;
  resolveTruthFact: RuntimeCallback<
    [sessionId: string, truthFactId: string],
    { ok: boolean; error?: string }
  >;
  recordTaskBlocker: RuntimeCallback<
    [
      sessionId: string,
      input: {
        id?: string;
        message: string;
        source?: string;
        truthFactId?: string;
      },
    ],
    { ok: boolean; blockerId?: string; error?: string }
  >;
  resolveTaskBlocker: RuntimeCallback<
    [sessionId: string, blockerId: string],
    { ok: boolean; error?: string }
  >;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
}

export class LedgerService {
  private readonly cwd: string;
  private readonly config: BrewvaConfig;
  private readonly ledger: EvidenceLedger;
  private readonly verification: VerificationGate;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly upsertTruthFact: LedgerServiceOptions["upsertTruthFact"];
  private readonly resolveTruthFact: LedgerServiceOptions["resolveTruthFact"];
  private readonly recordTaskBlocker: LedgerServiceOptions["recordTaskBlocker"];
  private readonly resolveTaskBlocker: LedgerServiceOptions["resolveTaskBlocker"];
  private readonly recordEvent: LedgerServiceOptions["recordEvent"];

  constructor(options: LedgerServiceOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.ledger = options.ledger;
    this.verification = options.verification;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getActiveSkill = options.getActiveSkill;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.upsertTruthFact = options.upsertTruthFact;
    this.resolveTruthFact = options.resolveTruthFact;
    this.recordTaskBlocker = options.recordTaskBlocker;
    this.resolveTaskBlocker = options.resolveTaskBlocker;
    this.recordEvent = options.recordEvent;
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

    syncTruthFromToolResult(
      {
        cwd: this.cwd,
        getTaskState: (sessionId) => this.getTaskState(sessionId),
        getTruthState: (sessionId) => this.getTruthState(sessionId),
        upsertTruthFact: (sessionId, truthInput) => this.upsertTruthFact(sessionId, truthInput),
        resolveTruthFact: (sessionId, truthFactId) => this.resolveTruthFact(sessionId, truthFactId),
        recordTaskBlocker: (sessionId, blockerInput) =>
          this.recordTaskBlocker(sessionId, blockerInput),
        resolveTaskBlocker: (sessionId, blockerId) => this.resolveTaskBlocker(sessionId, blockerId),
      },
      {
        sessionId: input.sessionId,
        toolName: input.toolName,
        args: input.args,
        outputText: input.outputText,
        verdict,
        ledgerRow: {
          id: ledgerRow.id,
          outputHash: ledgerRow.outputHash,
          argsSummary: ledgerRow.argsSummary,
          outputSummary: ledgerRow.outputSummary,
        },
        metadata,
      },
    );

    const evidence = classifyEvidence({
      now: Date.now(),
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      verdict,
    });
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

    this.verification.stateStore.appendEvidence(input.sessionId, evidence);
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
    const every = Math.max(0, Math.trunc(this.config.ledger.checkpointEveryTurns));
    if (every <= 0) return;
    if (turn <= 0) return;
    if (turn % every !== 0) return;
    if (this.sessionState.lastLedgerCompactionTurnBySession.get(sessionId) === turn) {
      return;
    }

    const keepLast = Math.max(2, Math.min(LEDGER_DIGEST_WINDOW, every - 1));
    const result = this.ledger.compactSession(sessionId, {
      keepLast,
      reason: `turn-${turn}`,
    });
    if (!result) return;
    this.sessionState.lastLedgerCompactionTurnBySession.set(sessionId, turn);
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
