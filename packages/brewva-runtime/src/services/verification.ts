import type {
  BrewvaConfig,
  TaskState,
  TruthFact,
  TruthFactSeverity,
  TruthFactStatus,
  TruthState,
  VerificationCheckRun,
  VerificationLevel,
  VerificationReport,
} from "../types.js";
import { runShellCommand } from "../utils/exec.js";
import type { VerificationGate } from "../verification/gate.js";
import type { RuntimeCallback } from "./callback.js";

const VERIFIER_BLOCKER_PREFIX = "verifier:" as const;

function normalizeVerifierCheckForId(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/[^a-z0-9._-]+/g, "-");
}

function buildVerifierBlockerMessage(input: {
  checkName: string;
  truthFactId: string;
  run?: VerificationCheckRun;
}): string {
  const parts: string[] = [`verification failed: ${input.checkName}`, `truth=${input.truthFactId}`];
  if (input.run?.ledgerId) {
    parts.push(`evidence=${input.run.ledgerId}`);
  }
  if (input.run && input.run.exitCode !== null && input.run.exitCode !== undefined) {
    parts.push(`exitCode=${input.run.exitCode}`);
  }
  return parts.join(" ");
}

export interface VerificationServiceOptions {
  cwd: string;
  config: BrewvaConfig;
  verification: VerificationGate;
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
  recordToolResult: RuntimeCallback<
    [
      input: {
        sessionId: string;
        toolName: string;
        args: Record<string, unknown>;
        outputText: string;
        success: boolean;
        verdict?: "pass" | "fail" | "inconclusive";
        metadata?: Record<string, unknown>;
      },
    ],
    string
  >;
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

export class VerificationService {
  private readonly cwd: string;
  private readonly config: BrewvaConfig;
  private readonly verification: VerificationGate;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly upsertTruthFact: VerificationServiceOptions["upsertTruthFact"];
  private readonly resolveTruthFact: VerificationServiceOptions["resolveTruthFact"];
  private readonly recordTaskBlocker: VerificationServiceOptions["recordTaskBlocker"];
  private readonly resolveTaskBlocker: VerificationServiceOptions["resolveTaskBlocker"];
  private readonly recordToolResult: VerificationServiceOptions["recordToolResult"];

  constructor(options: VerificationServiceOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.verification = options.verification;
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.upsertTruthFact = options.upsertTruthFact;
    this.resolveTruthFact = options.resolveTruthFact;
    this.recordTaskBlocker = options.recordTaskBlocker;
    this.resolveTaskBlocker = options.resolveTaskBlocker;
    this.recordToolResult = options.recordToolResult;
  }

  async verifyCompletion(
    sessionId: string,
    level?: VerificationLevel,
    options: VerifyCompletionOptions = {},
  ): Promise<VerificationReport> {
    const effectiveLevel = level ?? this.config.verification.defaultLevel;
    const executeCommands = options.executeCommands !== false;

    if (executeCommands && effectiveLevel !== "quick") {
      await this.runVerificationCommands(sessionId, effectiveLevel, {
        timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
      });
    }

    const report = this.verification.evaluate(sessionId, effectiveLevel, {
      requireCommands: executeCommands,
    });
    this.syncVerificationBlockers(sessionId, report);
    return report;
  }

  private syncVerificationBlockers(sessionId: string, report: VerificationReport): void {
    const verificationState = this.verification.stateStore.get(sessionId);
    if (!verificationState.lastWriteAt) return;

    const lastWriteAt = verificationState.lastWriteAt ?? 0;
    const current = this.getTaskState(sessionId);
    const existingById = new Map(current.blockers.map((blocker) => [blocker.id, blocker]));
    const failingIds = new Set<string>();
    const truthFactIdForCheck = (checkName: string): string =>
      `truth:verifier:${normalizeVerifierCheckForId(checkName)}`;

    for (const check of report.checks) {
      if (check.status !== "fail") continue;

      const blockerId = `${VERIFIER_BLOCKER_PREFIX}${normalizeVerifierCheckForId(check.name)}`;
      const truthFactId = truthFactIdForCheck(check.name);
      failingIds.add(blockerId);

      const run = verificationState.checkRuns[check.name];
      const freshRun = run && run.timestamp >= lastWriteAt ? run : undefined;
      const message = buildVerifierBlockerMessage({
        checkName: check.name,
        truthFactId,
        run: freshRun,
      });
      const source = "verification_gate";

      const existing = existingById.get(blockerId);
      if (
        existing &&
        existing.message === message &&
        (existing.source ?? "") === source &&
        (existing.truthFactId ?? "") === truthFactId
      ) {
        continue;
      }

      const evidenceIds = freshRun?.ledgerId ? [freshRun.ledgerId] : [];
      this.upsertTruthFact(sessionId, {
        id: truthFactId,
        kind: "verification_check_failed",
        severity: "error",
        summary: `verification failed: ${check.name}`,
        evidenceIds,
        details: {
          check: check.name,
          command: freshRun?.command ?? null,
          exitCode: freshRun?.exitCode ?? null,
          ledgerId: freshRun?.ledgerId ?? null,
          evidence: check.evidence ?? null,
        },
      });
      this.recordTaskBlocker(sessionId, {
        id: blockerId,
        message,
        source,
        truthFactId,
      });
    }

    const truthState = this.getTruthState(sessionId);
    for (const blocker of current.blockers) {
      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) continue;
      if (failingIds.has(blocker.id)) continue;
      this.resolveTaskBlocker(sessionId, blocker.id);
      const truthFactId =
        blocker.truthFactId ?? `truth:verifier:${blocker.id.slice(VERIFIER_BLOCKER_PREFIX.length)}`;
      const active = truthState.facts.find(
        (fact) => fact.id === truthFactId && fact.status === "active",
      );
      if (active) {
        this.resolveTruthFact(sessionId, truthFactId);
      }
    }
  }

  private async runVerificationCommands(
    sessionId: string,
    level: VerificationLevel,
    options: { timeoutMs: number },
  ): Promise<void> {
    const state = this.verification.stateStore.get(sessionId);
    if (!state.lastWriteAt) return;

    const checks = this.config.verification.checks[level] ?? [];
    for (const checkName of checks) {
      const command = this.config.verification.commands[checkName];
      if (!command) continue;
      if (checkName === "diff-review") continue;

      const existing = state.checkRuns[checkName];
      const isFresh = existing && existing.ok && existing.timestamp >= state.lastWriteAt;
      if (isFresh) continue;

      const result = await runShellCommand(command, {
        cwd: this.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputChars: 200_000,
      });

      const ok = result.exitCode === 0 && !result.timedOut;
      const outputText = `${result.stdout}\n${result.stderr}`.trim();
      const outputSummary =
        outputText.length > 0 ? outputText.slice(0, 2000) : ok ? "(no output)" : "(no output)";

      const timestamp = Date.now();
      const ledgerId = this.recordToolResult({
        sessionId,
        toolName: "brewva_verify",
        args: { check: checkName, command },
        outputText: outputSummary,
        success: ok,
        verdict: ok ? "pass" : "fail",
        metadata: {
          source: "verification_gate",
          check: checkName,
          command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        },
      });

      this.verification.stateStore.setCheckRun(sessionId, checkName, {
        timestamp,
        ok,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ledgerId,
        outputSummary,
      });
    }
  }
}
