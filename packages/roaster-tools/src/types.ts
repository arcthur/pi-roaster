import type {
  EvidenceQuery,
  RollbackResult,
  SessionCostSummary,
  SkillDocument,
  VerificationLevel,
  VerificationReport,
} from "@pi-roaster/roaster-runtime";

export interface RoasterToolRuntime {
  activateSkill(sessionId: string, name: string): { ok: boolean; reason?: string; skill?: SkillDocument };
  validateSkillOutputs(sessionId: string, outputs: Record<string, unknown>): { ok: boolean; missing: string[] };
  completeSkill(sessionId: string, outputs: Record<string, unknown>): { ok: boolean; missing: string[] };
  verifyCompletion(
    sessionId: string,
    level?: VerificationLevel,
    options?: { executeCommands?: boolean; timeoutMs?: number },
  ): Promise<VerificationReport>;
  rollbackLastPatchSet(sessionId: string): RollbackResult;
  queryLedger(sessionId: string, query: EvidenceQuery): string;
  getCostSummary(sessionId: string): SessionCostSummary;
  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown>;
}

export interface RoasterToolOptions {
  runtime: RoasterToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
