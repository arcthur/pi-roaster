import type { SchedulerService } from "../schedule/service.js";
import type {
  ScheduleIntentCancelInput,
  ScheduleIntentCancelResult,
  ScheduleIntentCreateInput,
  ScheduleIntentCreateResult,
  ScheduleIntentListQuery,
  ScheduleIntentProjectionRecord,
  ScheduleIntentUpdateInput,
  ScheduleIntentUpdateResult,
  ScheduleProjectionSnapshot,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";

export interface ScheduleIntentServiceOptions {
  createManager: RuntimeCallback<[], SchedulerService>;
}

export class ScheduleIntentService {
  private readonly createManager: () => SchedulerService;
  private manager: SchedulerService | null = null;

  constructor(options: ScheduleIntentServiceOptions) {
    this.createManager = options.createManager;
  }

  private getScheduleProjectionManager(): SchedulerService {
    if (!this.manager) {
      this.manager = this.createManager();
    }
    return this.manager;
  }

  private async ensureScheduleProjectionManager(): Promise<SchedulerService> {
    const manager = this.getScheduleProjectionManager();
    await manager.recover();
    return manager;
  }

  async createScheduleIntent(
    sessionId: string,
    input: ScheduleIntentCreateInput,
  ): Promise<ScheduleIntentCreateResult> {
    const manager = await this.ensureScheduleProjectionManager();
    return manager.createIntent({
      parentSessionId: sessionId,
      reason: input.reason,
      goalRef: input.goalRef,
      continuityMode: input.continuityMode,
      runAt: input.runAt,
      cron: input.cron,
      timeZone: input.timeZone,
      maxRuns: input.maxRuns,
      intentId: input.intentId,
      convergenceCondition: input.convergenceCondition,
    });
  }

  async cancelScheduleIntent(
    sessionId: string,
    input: ScheduleIntentCancelInput,
  ): Promise<ScheduleIntentCancelResult> {
    const manager = await this.ensureScheduleProjectionManager();
    return manager.cancelIntent({
      parentSessionId: sessionId,
      intentId: input.intentId,
      reason: input.reason,
    });
  }

  async updateScheduleIntent(
    sessionId: string,
    input: ScheduleIntentUpdateInput,
  ): Promise<ScheduleIntentUpdateResult> {
    const manager = await this.ensureScheduleProjectionManager();
    return manager.updateIntent({
      parentSessionId: sessionId,
      intentId: input.intentId,
      reason: input.reason,
      goalRef: input.goalRef,
      continuityMode: input.continuityMode,
      runAt: input.runAt,
      cron: input.cron,
      timeZone: input.timeZone,
      maxRuns: input.maxRuns,
      convergenceCondition: input.convergenceCondition,
    });
  }

  async listScheduleIntents(
    query: ScheduleIntentListQuery = {},
  ): Promise<ScheduleIntentProjectionRecord[]> {
    const manager = await this.ensureScheduleProjectionManager();
    return manager.listIntents(query);
  }

  async getScheduleProjectionSnapshot(): Promise<ScheduleProjectionSnapshot> {
    const manager = await this.ensureScheduleProjectionManager();
    return manager.snapshot();
  }
}
