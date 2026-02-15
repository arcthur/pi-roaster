import type { RoasterConfig, VerificationLevel, VerificationReport } from "../types.js";
import { VerificationStateStore } from "./state.js";

export interface VerificationGateOptions {
  requireCommands?: boolean;
}

export class VerificationGate {
  private readonly config: RoasterConfig;
  private readonly store: VerificationStateStore;

  constructor(config: RoasterConfig, store?: VerificationStateStore) {
    this.config = config;
    this.store = store ?? new VerificationStateStore();
  }

  get stateStore(): VerificationStateStore {
    return this.store;
  }

  evaluate(
    sessionId: string,
    level: VerificationLevel = this.config.verification.defaultLevel,
    options: VerificationGateOptions = {},
  ): VerificationReport {
    const requireCommands = options.requireCommands === true && level !== "quick";
    const state = this.store.get(sessionId);
    const hasWrite = Boolean(state.lastWriteAt);
    const lastWriteAt = state.lastWriteAt ?? 0;

    const lspEvidence = state.evidence.filter(
      (entry) => entry.kind === "lsp_clean" && (!state.lastWriteAt || entry.timestamp >= state.lastWriteAt),
    );
    const testEvidence = state.evidence.filter(
      (entry) => entry.kind === "test_or_build_passed" && (!state.lastWriteAt || entry.timestamp >= state.lastWriteAt),
    );

    const checks = this.config.verification.checks[level].map((name) => {
      if (!hasWrite) {
        return { name, status: "pass" } as const;
      }

      if (name === "diff-review") {
        return {
          name,
          status: "skip",
        } as const;
      }

      const command = this.config.verification.commands[name];
      const checkRun = state.checkRuns[name];
      const freshRun = checkRun && checkRun.timestamp >= lastWriteAt ? checkRun : undefined;

      if (requireCommands && command) {
        return {
          name,
          status: freshRun?.ok ? "pass" : "fail",
          evidence: freshRun
            ? `${freshRun.ok ? "pass" : "fail"} (${freshRun.exitCode ?? "null"}) ${freshRun.command}`
            : `missing command run: ${command}`,
        } as const;
      }

      if (name === "type-check") {
        return {
          name,
          status: lspEvidence.length > 0 ? "pass" : "fail",
          evidence: lspEvidence[0]?.detail,
        } as const;
      }
      if (name === "tests") {
        return {
          name,
          status: testEvidence.length > 0 ? "pass" : "fail",
          evidence: testEvidence[0]?.detail,
        } as const;
      }
      if (name === "lint") {
        return {
          name,
          status: lspEvidence.length > 0 ? "pass" : "skip",
        } as const;
      }
      return {
        name,
        status: "skip",
      } as const;
    });

    const missingEvidence: string[] = [];
    if (hasWrite) {
      if (requireCommands) {
        for (const check of checks) {
          if (check.status === "fail") missingEvidence.push(check.name);
        }
      } else {
        if (lspEvidence.length === 0) missingEvidence.push("lsp_diagnostics");
        if (testEvidence.length === 0) missingEvidence.push("test_or_build");
      }
    }

    const passed = missingEvidence.length === 0;
    if (passed) {
      this.store.resetDenials(sessionId);
    } else {
      this.store.bumpDenials(sessionId);
    }

    return {
      passed,
      level,
      missingEvidence,
      checks,
    };
  }
}
