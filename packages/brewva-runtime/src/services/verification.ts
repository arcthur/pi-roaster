import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "../events/event-types.js";
import type { GovernancePort } from "../governance/port.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { BrewvaConfig, TaskState, VerificationLevel, VerificationReport } from "../types.js";
import { runShellCommand } from "../utils/exec.js";
import type { VerificationGate } from "../verification/gate.js";
import type { LedgerService } from "./ledger.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import type { TrustMeterService } from "./trust-meter.js";

function compactText(value: string, maxChars = 800): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function sanitizeKeyToken(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact || "unknown";
}

function buildVerificationLessonKey(input: {
  level: VerificationLevel;
  activeSkillName?: string;
  checkNames: string[];
}): string {
  const normalizedChecks = [...new Set(input.checkNames.map((name) => sanitizeKeyToken(name)))]
    .filter(Boolean)
    .toSorted();
  const checks = normalizedChecks.length > 0 ? normalizedChecks.join("+") : "none";
  const skill = input.activeSkillName ? sanitizeKeyToken(input.activeSkillName) : "none";
  return `verification:${sanitizeKeyToken(input.level)}:${skill}:${checks}`;
}

export interface VerificationServiceOptions {
  cwd: RuntimeKernelContext["cwd"];
  config: RuntimeKernelContext["config"];
  verificationGate: RuntimeKernelContext["verificationGate"];
  getTaskState: RuntimeKernelContext["getTaskState"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  governancePort?: GovernancePort;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  ledgerService: Pick<LedgerService, "recordToolResult">;
  trustMeterService: TrustMeterService;
}

export interface VerifyCompletionOptions {
  executeCommands?: boolean;
  timeoutMs?: number;
}

export class VerificationService {
  private readonly cwd: string;
  private readonly config: BrewvaConfig;
  private readonly verification: VerificationGate;
  private readonly governancePort?: GovernancePort;
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getActiveSkillName: (sessionId: string) => string | undefined;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
  private readonly recordToolResult: (input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    channelSuccess: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }) => string;
  private readonly trustMeter: TrustMeterService;

  constructor(options: VerificationServiceOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.verification = options.verificationGate;
    this.governancePort = options.governancePort;
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getActiveSkillName = (sessionId) =>
      options.skillLifecycleService.getActiveSkill(sessionId)?.name;
    this.recordEvent = (input) => options.recordEvent(input);
    this.recordToolResult = (input) => options.ledgerService.recordToolResult(input);
    this.trustMeter = options.trustMeterService;
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
    this.recordVerificationOutcome(sessionId, effectiveLevel, report);
    await this.applyGovernanceVerification(sessionId, effectiveLevel, report);
    return report;
  }

  private recordVerificationOutcome(
    sessionId: string,
    level: VerificationLevel,
    report: VerificationReport,
  ): void {
    const verificationState = this.verification.stateStore.get(sessionId);
    const taskState = this.getTaskState(sessionId);
    const taskGoal = taskState.spec?.goal?.trim() ?? "";
    const activeSkillName = this.getActiveSkillName(sessionId);
    const outcome: "pass" | "fail" | "skipped" = report.skipped
      ? "skipped"
      : report.passed
        ? "pass"
        : "fail";
    const checkNames = report.checks.map((check) => check.name);
    const lessonKey = buildVerificationLessonKey({
      level,
      activeSkillName: activeSkillName ?? undefined,
      checkNames,
    });
    const pattern = `verification:${sanitizeKeyToken(level)}:${activeSkillName ? sanitizeKeyToken(activeSkillName) : "none"}`;
    const failedChecks = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.name);
    const referenceWriteAt = verificationState.lastWriteAt ?? 0;
    const checkProvenance = report.checks.map((check) => {
      const run = verificationState.checkRuns[check.name];
      const hasRun = Boolean(run);
      const freshSinceWrite = run ? run.timestamp >= referenceWriteAt : false;
      return {
        check: check.name,
        status: check.status,
        command: run?.command ?? null,
        hasRun,
        freshSinceWrite,
        runTimestamp: run?.timestamp ?? null,
        ledgerId: run?.ledgerId ?? null,
      };
    });
    const commandsExecuted = checkProvenance
      .filter((entry) => entry.hasRun)
      .map((entry) => entry.check);
    const commandsFresh = checkProvenance
      .filter((entry) => entry.hasRun && entry.freshSinceWrite)
      .map((entry) => entry.check);
    const commandsStale = checkProvenance
      .filter((entry) => entry.hasRun && !entry.freshSinceWrite)
      .map((entry) => entry.check);
    const commandsMissing = report.checks
      .filter((check) => check.status !== "skip" && !commandsExecuted.includes(check.name))
      .map((check) => check.name);
    const evidenceFreshness =
      commandsExecuted.length === 0
        ? "none"
        : commandsFresh.length === commandsExecuted.length
          ? "fresh"
          : commandsFresh.length === 0
            ? "stale"
            : "mixed";

    const statusSummary = report.checks
      .map((check) => `${check.name}:${check.status}`)
      .slice(0, 12)
      .join(", ");
    const strategyParts = [`verification_level=${level}`];
    if (activeSkillName) strategyParts.push(`skill=${activeSkillName}`);
    if (statusSummary) strategyParts.push(`checks=${statusSummary}`);
    const strategy = compactText(strategyParts.join("; "), 600);

    const evidenceParts: string[] = [];
    const evidenceIds: string[] = [];
    for (const checkName of failedChecks) {
      const run = verificationState.checkRuns[checkName];
      if (!run) continue;
      if (run.timestamp < referenceWriteAt) continue;
      if (run.ledgerId) evidenceIds.push(run.ledgerId);
      const detail = run.outputSummary
        ? `${checkName}: ${compactText(run.outputSummary, 360)}`
        : `${checkName}: exitCode=${run.exitCode ?? "unknown"}`;
      evidenceParts.push(detail);
    }
    if (evidenceParts.length === 0) {
      for (const check of report.checks) {
        if (check.status !== "fail") continue;
        if (!check.evidence) continue;
        evidenceParts.push(`${check.name}: ${compactText(check.evidence, 360)}`);
      }
    }

    const evidence = compactText(
      evidenceParts.length > 0 ? evidenceParts.join(" | ") : "no_failed_check_output_captured",
      1200,
    );
    const rootCause =
      outcome === "fail"
        ? report.missingEvidence.length > 0
          ? `missing evidence: ${report.missingEvidence.join(", ")}`
          : failedChecks.length > 0
            ? `failed checks: ${failedChecks.join(", ")}`
            : "verification failed without explicit check attribution"
        : outcome === "skipped"
          ? "read-only session, verification skipped"
          : "verification checks passed";
    const recommendation =
      outcome === "fail"
        ? failedChecks.length > 0
          ? `stabilize checks (${failedChecks.join(", ")}) and rerun ${level} verification`
          : `re-run ${level} verification with focused diagnostics`
        : outcome === "skipped"
          ? null
          : `reuse verification profile ${level} for similar tasks`;

    this.recordEvent({
      sessionId,
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      payload: {
        schema: "brewva.verification.outcome.v1",
        level,
        outcome,
        lessonKey,
        pattern,
        rootCause,
        recommendation,
        taskGoal: taskGoal || null,
        strategy,
        failedChecks,
        missingEvidence: report.missingEvidence,
        skipped: report.skipped,
        reason: report.reason ?? null,
        evidence,
        evidenceIds: [...new Set(evidenceIds)],
        checkResults: report.checks.map((check) => ({
          name: check.name,
          status: check.status,
          evidence: check.evidence ?? null,
        })),
        provenanceVersion: "v2",
        activeSkill: activeSkillName ?? null,
        referenceWriteAt: referenceWriteAt > 0 ? referenceWriteAt : null,
        evidenceFreshness,
        commandsExecuted,
        commandsFresh,
        commandsStale,
        commandsMissing,
        checkProvenance,
      },
    });
    this.trustMeter.observeVerificationOutcome({
      sessionId,
      outcome,
      evidenceFreshness,
    });
  }

  private async applyGovernanceVerification(
    sessionId: string,
    level: VerificationLevel,
    report: VerificationReport,
  ): Promise<void> {
    const governancePort = this.governancePort;
    if (!governancePort?.verifySpec) return;

    try {
      const result = await Promise.resolve(governancePort.verifySpec({ sessionId, level, report }));
      if (result.ok) {
        this.recordEvent({
          sessionId,
          type: "governance_verify_spec_passed",
          payload: {
            level,
          },
        });
        return;
      }

      const reason = (result.reason ?? "unknown").trim() || "unknown";
      this.recordEvent({
        sessionId,
        type: "governance_verify_spec_failed",
        payload: {
          level,
          reason,
        },
      });
    } catch (error) {
      this.recordEvent({
        sessionId,
        type: "governance_verify_spec_error",
        payload: {
          level,
          error: error instanceof Error ? error.message : String(error),
        },
      });
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

      this.recordToolResult({
        sessionId,
        toolName: "brewva_verify",
        args: { check: checkName, command },
        outputText: outputSummary,
        channelSuccess: ok,
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
    }
  }
}
