import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { resolveSecurityPolicy } from "../security/mode.js";
import type {
  ParallelAcquireResult,
  SkillDocument,
  WorkerMergeReport,
  WorkerResult,
} from "../types.js";
import type { ResourceLeaseService } from "./resource-lease.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

export interface ParallelServiceOptions {
  securityConfig: RuntimeKernelContext["config"]["security"];
  parallel: RuntimeKernelContext["parallel"];
  parallelResults: RuntimeKernelContext["parallelResults"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  resourceLeaseService: Pick<ResourceLeaseService, "getEffectiveBudget">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
}

export class ParallelService {
  private readonly securityPolicy: ReturnType<typeof resolveSecurityPolicy>;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getEffectiveBudget: ResourceLeaseService["getEffectiveBudget"];
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;

  constructor(options: ParallelServiceOptions) {
    this.securityPolicy = resolveSecurityPolicy(options.securityConfig);
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.sessionState = options.sessionState;
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getEffectiveBudget = (sessionId, contract, skillName) =>
      options.resourceLeaseService.getEffectiveBudget(sessionId, contract, skillName);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  acquireParallelSlot(sessionId: string, runId: string): ParallelAcquireResult {
    return this.tryAcquireParallelSlot(sessionId, runId, { recordRejection: true });
  }

  async acquireParallelSlotAsync(
    sessionId: string,
    runId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ParallelAcquireResult> {
    const immediate = this.tryAcquireParallelSlot(sessionId, runId, { recordRejection: false });
    if (immediate.accepted || immediate.reason !== "max_concurrent") {
      if (!immediate.accepted) {
        this.recordParallelRejection(sessionId, runId, immediate.reason);
      }
      return immediate;
    }

    const acquired = await this.parallel.acquireAsync(sessionId, runId, options);
    if (!acquired.accepted) {
      this.recordParallelRejection(sessionId, runId, acquired.reason);
    }
    return acquired;
  }

  releaseParallelSlot(sessionId: string, runId: string): void {
    this.parallel.release(sessionId, runId);
  }

  recordWorkerResult(sessionId: string, result: WorkerResult): void {
    this.parallelResults.record(sessionId, result);
    this.parallel.release(sessionId, result.workerId);
  }

  listWorkerResults(sessionId: string): WorkerResult[] {
    return this.parallelResults.list(sessionId);
  }

  mergeWorkerResults(sessionId: string): WorkerMergeReport {
    return this.parallelResults.merge(sessionId);
  }

  clearWorkerResults(sessionId: string): void {
    this.parallelResults.clear(sessionId);
  }

  private tryAcquireParallelSlot(
    sessionId: string,
    runId: string,
    options: { recordRejection: boolean },
  ): ParallelAcquireResult {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.getActiveSkill(sessionId);
    const effectiveBudget =
      skill?.contract !== undefined
        ? this.getEffectiveBudget(sessionId, skill.contract, skill.name)
        : undefined;
    const maxParallel = effectiveBudget?.maxParallel;

    if (
      skill &&
      typeof maxParallel === "number" &&
      maxParallel > 0 &&
      this.securityPolicy.skillMaxParallelMode !== "off"
    ) {
      const activeRuns = this.parallel.getActiveRunCount(sessionId);
      if (activeRuns >= maxParallel) {
        const mode = this.securityPolicy.skillMaxParallelMode;
        if (mode === "warn") {
          const key = `maxParallel:${skill.name}`;
          const seen = state.skillParallelWarnings;
          if (!seen.has(key)) {
            seen.add(key);
            this.recordEvent({
              sessionId,
              type: "skill_parallel_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                activeRuns,
                maxParallel,
                mode,
              },
            });
          }
        } else if (mode === "enforce") {
          if (options.recordRejection) {
            this.recordEvent({
              sessionId,
              type: "parallel_slot_rejected",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                runId,
                skill: skill.name,
                reason: "skill_max_parallel",
                activeRuns,
                maxParallel,
              },
            });
          }
          return { accepted: false, reason: "skill_max_parallel" };
        }
      }
    }

    const acquired = this.parallel.acquire(sessionId, runId);
    if (!acquired.accepted && options.recordRejection) {
      this.recordParallelRejection(sessionId, runId, acquired.reason, skill?.name);
    }
    return acquired;
  }

  private recordParallelRejection(
    sessionId: string,
    runId: string,
    reason: ParallelAcquireResult["reason"],
    skillName?: string,
  ): void {
    this.recordEvent({
      sessionId,
      type: "parallel_slot_rejected",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        runId,
        skill: skillName ?? this.getActiveSkill(sessionId)?.name ?? null,
        reason: reason ?? "unknown",
      },
    });
  }
}
