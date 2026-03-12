import type { SessionCostTracker } from "../cost/tracker.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { resolveSecurityPolicy } from "../security/mode.js";
import { checkToolAccess as evaluateSkillToolAccess } from "../security/tool-policy.js";
import type { ContextBudgetUsage, SkillDocument } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import { resolveToolResultVerdict } from "../utils/tool-result.js";
import type { ContextService } from "./context.js";
import type { FileChangeService } from "./file-change.js";
import type { LedgerService } from "./ledger.js";
import type { ResourceLeaseService } from "./resource-lease.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import type { StallDetectorService } from "./stall-detector.js";

export interface ToolAccessDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolAccessExplanation extends ToolAccessDecision {
  warning?: string;
}

export interface StartToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  usage?: ContextBudgetUsage;
  recordLifecycleEvent?: boolean;
}

export interface FinishToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  channelSuccess: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  metadata?: Record<string, unknown>;
}

export interface ToolGateServiceOptions {
  securityConfig: RuntimeKernelContext["config"]["security"];
  costTracker: RuntimeKernelContext["costTracker"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  alwaysAllowedTools: string[];
  resourceLeaseService: Pick<ResourceLeaseService, "getEffectiveBudget">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  contextService: Pick<ContextService, "checkContextCompactionGate" | "observeContextUsage">;
  fileChangeService: Pick<
    FileChangeService,
    "markToolCall" | "trackToolCallStart" | "trackToolCallEnd"
  >;
  ledgerService: Pick<LedgerService, "recordToolResult">;
  stallDetectorService: Pick<StallDetectorService, "checkToolCall" | "observeToolResult">;
}

interface ToolStartGate {
  id: "stall_detection" | "tool_access" | "context_compaction";
  evaluate(input: StartToolCallInput): ToolAccessDecision;
}

export class ToolGateService {
  private readonly securityPolicy: ReturnType<typeof resolveSecurityPolicy>;
  private readonly costTracker: SessionCostTracker;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly alwaysAllowedTools: string[];
  private readonly alwaysAllowedToolSet: Set<string>;
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
  private readonly checkContextCompactionGate: (
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ) => ToolAccessDecision;
  private readonly observeContextUsage: (
    sessionId: string,
    usage: ContextBudgetUsage | undefined,
  ) => void;
  private readonly markToolCall: (sessionId: string, toolName: string) => void;
  private readonly trackToolCallStart: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }) => void;
  private readonly recordToolResult: (input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    outputText: string;
    channelSuccess: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    metadata?: Record<string, unknown>;
  }) => string;
  private readonly trackToolCallEnd: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    channelSuccess: boolean;
  }) => void;
  private readonly checkStallDetection: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }) => ToolAccessDecision;
  private readonly observeStallToolResult: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    verdict: "pass" | "fail" | "inconclusive";
    outputText: string;
  }) => void;
  private readonly startGateChain: ReadonlyArray<ToolStartGate>;

  constructor(options: ToolGateServiceOptions) {
    this.securityPolicy = resolveSecurityPolicy(options.securityConfig);
    this.costTracker = options.costTracker;
    this.sessionState = options.sessionState;
    this.alwaysAllowedTools = options.alwaysAllowedTools;
    this.alwaysAllowedToolSet = new Set(
      options.alwaysAllowedTools
        .map((toolName) => normalizeToolName(toolName))
        .filter((toolName) => toolName.length > 0),
    );
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getEffectiveBudget = (sessionId, contract, skillName) =>
      options.resourceLeaseService.getEffectiveBudget(sessionId, contract, skillName);
    this.recordEvent = (input) => options.recordEvent(input);
    this.checkContextCompactionGate = (sessionId, toolName, usage) =>
      options.contextService.checkContextCompactionGate(sessionId, toolName, usage);
    this.observeContextUsage = (sessionId, usage) =>
      options.contextService.observeContextUsage(sessionId, usage);
    this.markToolCall = (sessionId, toolName) =>
      options.fileChangeService.markToolCall(sessionId, toolName);
    this.trackToolCallStart = (input) => options.fileChangeService.trackToolCallStart(input);
    this.recordToolResult = (input) => options.ledgerService.recordToolResult(input);
    this.trackToolCallEnd = (input) => options.fileChangeService.trackToolCallEnd(input);
    this.checkStallDetection = (input) => options.stallDetectorService.checkToolCall(input);
    this.observeStallToolResult = (input) => options.stallDetectorService.observeToolResult(input);
    this.startGateChain = [
      {
        id: "stall_detection",
        evaluate: (input) =>
          this.checkStallDetection({
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            args: input.args,
          }),
      },
      {
        id: "tool_access",
        evaluate: (input) => this.checkToolAccess(input.sessionId, input.toolName),
      },
      {
        id: "context_compaction",
        evaluate: (input) =>
          this.checkContextCompactionGate(input.sessionId, input.toolName, input.usage),
      },
    ];
  }

  checkToolAccess(sessionId: string, toolName: string): ToolAccessDecision {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.getActiveSkill(sessionId);
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      const reason = `Tool '${normalizedToolName}' has been removed. Use 'exec' with 'process' for command execution.`;
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason,
        },
      });
      return { allowed: false, reason };
    }

    const access = evaluateSkillToolAccess(skill?.contract, toolName, {
      enforceDeniedEffects: this.securityPolicy.enforceDeniedEffects,
      effectAuthorizationMode: this.securityPolicy.effectAuthorizationMode,
      alwaysAllowedTools: this.alwaysAllowedTools,
    });

    if (access.warning && skill) {
      const key = `${skill.name}:${normalizedToolName}`;
      const seen = state.toolContractWarnings;
      if (!seen.has(key)) {
        seen.add(key);
        this.recordEvent({
          sessionId,
          type: "tool_contract_warning",
          turn: this.getCurrentTurn(sessionId),
          payload: {
            skill: skill.name,
            toolName: normalizedToolName,
            mode: this.securityPolicy.effectAuthorizationMode,
            reason: access.warning,
          },
        });
      }
    }

    if (!access.allowed) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason: access.reason ?? "Tool call blocked.",
        },
      });
      return { allowed: false, reason: access.reason };
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    if (budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason: budget.reason ?? "Session budget exceeded.",
        },
      });
      return {
        allowed: false,
        reason: budget.reason ?? "Session budget exceeded.",
      };
    }

    if (!skill) {
      return access;
    }

    const effectiveBudget = this.getEffectiveBudget(sessionId, skill.contract, skill.name);

    if (
      this.securityPolicy.skillMaxTokensMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxTokens = effectiveBudget?.maxTokens;
      if (typeof maxTokens === "number") {
        const usedTokens = this.costTracker.getSkillTotalTokens(sessionId, skill.name);
        if (usedTokens >= maxTokens) {
          const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
          if (this.securityPolicy.skillMaxTokensMode === "warn") {
            const key = `maxTokens:${skill.name}`;
            const seen = state.skillBudgetWarnings;
            if (!seen.has(key)) {
              seen.add(key);
              this.recordEvent({
                sessionId,
                type: "skill_budget_warning",
                turn: this.getCurrentTurn(sessionId),
                payload: {
                  skill: skill.name,
                  usedTokens,
                  maxTokens,
                  budget: "tokens",
                  mode: this.securityPolicy.skillMaxTokensMode,
                },
              });
            }
          } else if (this.securityPolicy.skillMaxTokensMode === "enforce") {
            this.recordEvent({
              sessionId,
              type: "tool_call_blocked",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                toolName: normalizedToolName,
                skill: skill.name,
                reason,
              },
            });
            return { allowed: false, reason };
          }
        }
      }
    }

    if (
      this.securityPolicy.skillMaxToolCallsMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxToolCalls = effectiveBudget?.maxToolCalls;
      if (typeof maxToolCalls === "number") {
        const usedCalls = state.toolCalls;
        if (usedCalls >= maxToolCalls) {
          const reason = `Skill '${skill.name}' exceeded maxToolCalls=${maxToolCalls} (used=${usedCalls}).`;
          if (this.securityPolicy.skillMaxToolCallsMode === "warn") {
            const key = `maxToolCalls:${skill.name}`;
            const seen = state.skillBudgetWarnings;
            if (!seen.has(key)) {
              seen.add(key);
              this.recordEvent({
                sessionId,
                type: "skill_budget_warning",
                turn: this.getCurrentTurn(sessionId),
                payload: {
                  skill: skill.name,
                  usedToolCalls: usedCalls,
                  maxToolCalls,
                  budget: "tool_calls",
                  mode: this.securityPolicy.skillMaxToolCallsMode,
                },
              });
            }
          } else if (this.securityPolicy.skillMaxToolCallsMode === "enforce") {
            this.recordEvent({
              sessionId,
              type: "tool_call_blocked",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                toolName: normalizedToolName,
                skill: skill.name,
                reason,
              },
            });
            return { allowed: false, reason };
          }
        }
      }
    }

    return access;
  }

  explainToolAccess(sessionId: string, toolName: string): ToolAccessExplanation {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.getActiveSkill(sessionId);
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      return {
        allowed: false,
        reason: `Tool '${normalizedToolName}' has been removed. Use 'exec' with 'process' for command execution.`,
      };
    }

    const access = evaluateSkillToolAccess(skill?.contract, toolName, {
      enforceDeniedEffects: this.securityPolicy.enforceDeniedEffects,
      effectAuthorizationMode: this.securityPolicy.effectAuthorizationMode,
      alwaysAllowedTools: this.alwaysAllowedTools,
    });

    if (!access.allowed) {
      return { allowed: false, reason: access.reason };
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    if (budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)) {
      return {
        allowed: false,
        reason: budget.reason ?? "Session budget exceeded.",
      };
    }

    if (!skill) {
      return {
        allowed: true,
        warning: access.warning,
      };
    }

    const effectiveBudget = this.getEffectiveBudget(sessionId, skill.contract, skill.name);

    if (
      this.securityPolicy.skillMaxTokensMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxTokens = effectiveBudget?.maxTokens;
      if (typeof maxTokens === "number") {
        const usedTokens = this.costTracker.getSkillTotalTokens(sessionId, skill.name);
        if (usedTokens >= maxTokens) {
          const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
          if (this.securityPolicy.skillMaxTokensMode === "enforce") {
            return { allowed: false, reason };
          }
          if (this.securityPolicy.skillMaxTokensMode === "warn") {
            return { allowed: true, warning: reason };
          }
        }
      }
    }

    if (
      this.securityPolicy.skillMaxToolCallsMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxToolCalls = effectiveBudget?.maxToolCalls;
      if (typeof maxToolCalls === "number") {
        const usedCalls = state.toolCalls;
        if (usedCalls >= maxToolCalls) {
          const reason = `Skill '${skill.name}' exceeded maxToolCalls=${maxToolCalls} (used=${usedCalls}).`;
          if (this.securityPolicy.skillMaxToolCallsMode === "enforce") {
            return { allowed: false, reason };
          }
          if (this.securityPolicy.skillMaxToolCallsMode === "warn") {
            return { allowed: true, warning: reason };
          }
        }
      }
    }

    return {
      allowed: true,
      warning: access.warning,
    };
  }

  startToolCall(input: StartToolCallInput): ToolAccessDecision {
    if (input.usage) {
      this.observeContextUsage(input.sessionId, input.usage);
    }

    if (input.recordLifecycleEvent) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
        },
      });
    }

    const gateDecision = this.evaluateStartGateChain(input);
    if (!gateDecision.allowed) return gateDecision;

    this.markToolCall(input.sessionId, input.toolName);
    this.trackToolCallStart({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    });
    return { allowed: true };
  }

  private evaluateStartGateChain(input: StartToolCallInput): ToolAccessDecision {
    for (const gate of this.startGateChain) {
      const decision = gate.evaluate(input);
      if (!decision.allowed) {
        return decision;
      }
    }
    return { allowed: true };
  }

  finishToolCall(input: FinishToolCallInput): string {
    const verdict = resolveToolResultVerdict({
      verdict: input.verdict,
      channelSuccess: input.channelSuccess,
    });
    const ledgerId = this.recordToolResult({
      sessionId: input.sessionId,
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      channelSuccess: input.channelSuccess,
      verdict,
      metadata: input.metadata,
    });
    this.observeStallToolResult({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      verdict,
      outputText: input.outputText,
    });
    this.trackToolCallEnd({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      channelSuccess: input.channelSuccess,
    });
    return ledgerId;
  }
}
