import type { SessionCostTracker } from "../cost/tracker.js";
import { checkToolAccess as evaluateSkillToolAccess } from "../security/tool-policy.js";
import type { BrewvaConfig, ContextBudgetUsage, SkillDocument } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface ToolAccessDecision {
  allowed: boolean;
  reason?: string;
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
  success: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  metadata?: Record<string, unknown>;
}

export interface ToolGateServiceOptions {
  securityConfig: BrewvaConfig["security"];
  costTracker: SessionCostTracker;
  sessionState: RuntimeSessionStateStore;
  alwaysAllowedTools: string[];
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
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
  checkContextCompactionGate: RuntimeCallback<
    [sessionId: string, toolName: string, usage?: ContextBudgetUsage],
    ToolAccessDecision
  >;
  observeContextUsage: RuntimeCallback<[sessionId: string, usage: ContextBudgetUsage | undefined]>;
  markToolCall: RuntimeCallback<[sessionId: string, toolName: string]>;
  trackToolCallStart: RuntimeCallback<
    [
      input: {
        sessionId: string;
        toolCallId: string;
        toolName: string;
        args?: Record<string, unknown>;
      },
    ]
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
  trackToolCallEnd: RuntimeCallback<
    [
      input: {
        sessionId: string;
        toolCallId: string;
        toolName: string;
        success: boolean;
      },
    ]
  >;
}

export class ToolGateService {
  private readonly securityConfig: BrewvaConfig["security"];
  private readonly costTracker: SessionCostTracker;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly alwaysAllowedTools: string[];
  private readonly alwaysAllowedToolSet: Set<string>;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: ToolGateServiceOptions["recordEvent"];
  private readonly checkContextCompactionGate: ToolGateServiceOptions["checkContextCompactionGate"];
  private readonly observeContextUsage: ToolGateServiceOptions["observeContextUsage"];
  private readonly markToolCall: ToolGateServiceOptions["markToolCall"];
  private readonly trackToolCallStart: ToolGateServiceOptions["trackToolCallStart"];
  private readonly recordToolResult: ToolGateServiceOptions["recordToolResult"];
  private readonly trackToolCallEnd: ToolGateServiceOptions["trackToolCallEnd"];

  constructor(options: ToolGateServiceOptions) {
    this.securityConfig = options.securityConfig;
    this.costTracker = options.costTracker;
    this.sessionState = options.sessionState;
    this.alwaysAllowedTools = options.alwaysAllowedTools;
    this.alwaysAllowedToolSet = new Set(
      options.alwaysAllowedTools
        .map((toolName) => normalizeToolName(toolName))
        .filter((toolName) => toolName.length > 0),
    );
    this.getActiveSkill = options.getActiveSkill;
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
    this.checkContextCompactionGate = options.checkContextCompactionGate;
    this.observeContextUsage = options.observeContextUsage;
    this.markToolCall = options.markToolCall;
    this.trackToolCallStart = options.trackToolCallStart;
    this.recordToolResult = options.recordToolResult;
    this.trackToolCallEnd = options.trackToolCallEnd;
  }

  checkToolAccess(sessionId: string, toolName: string): ToolAccessDecision {
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
      enforceDeniedTools: this.securityConfig.enforceDeniedTools,
      allowedToolsMode: this.securityConfig.allowedToolsMode,
      alwaysAllowedTools: this.alwaysAllowedTools,
    });

    if (access.warning && skill) {
      const key = `${skill.name}:${normalizedToolName}`;
      const seen =
        this.sessionState.toolContractWarningsBySession.get(sessionId) ?? new Set<string>();
      if (!seen.has(key)) {
        seen.add(key);
        this.sessionState.toolContractWarningsBySession.set(sessionId, seen);
        this.recordEvent({
          sessionId,
          type: "tool_contract_warning",
          turn: this.getCurrentTurn(sessionId),
          payload: {
            skill: skill.name,
            toolName: normalizedToolName,
            mode: this.securityConfig.allowedToolsMode,
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

    if (
      this.securityConfig.skillMaxTokensMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxTokens = skill.contract.budget.maxTokens;
      const usedTokens = this.costTracker.getSkillTotalTokens(sessionId, skill.name);
      if (usedTokens >= maxTokens) {
        const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
        if (this.securityConfig.skillMaxTokensMode === "warn") {
          const key = `maxTokens:${skill.name}`;
          const seen =
            this.sessionState.skillBudgetWarningsBySession.get(sessionId) ?? new Set<string>();
          if (!seen.has(key)) {
            seen.add(key);
            this.sessionState.skillBudgetWarningsBySession.set(sessionId, seen);
            this.recordEvent({
              sessionId,
              type: "skill_budget_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                usedTokens,
                maxTokens,
                budget: "tokens",
                mode: this.securityConfig.skillMaxTokensMode,
              },
            });
          }
        } else if (this.securityConfig.skillMaxTokensMode === "enforce") {
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

    if (
      this.securityConfig.skillMaxToolCallsMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxToolCalls = skill.contract.budget.maxToolCalls;
      const usedCalls = this.sessionState.toolCallsBySession.get(sessionId) ?? 0;
      if (usedCalls >= maxToolCalls) {
        const reason = `Skill '${skill.name}' exceeded maxToolCalls=${maxToolCalls} (used=${usedCalls}).`;
        if (this.securityConfig.skillMaxToolCallsMode === "warn") {
          const key = `maxToolCalls:${skill.name}`;
          const seen =
            this.sessionState.skillBudgetWarningsBySession.get(sessionId) ?? new Set<string>();
          if (!seen.has(key)) {
            seen.add(key);
            this.sessionState.skillBudgetWarningsBySession.set(sessionId, seen);
            this.recordEvent({
              sessionId,
              type: "skill_budget_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                usedToolCalls: usedCalls,
                maxToolCalls,
                budget: "tool_calls",
                mode: this.securityConfig.skillMaxToolCallsMode,
              },
            });
          }
        } else if (this.securityConfig.skillMaxToolCallsMode === "enforce") {
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

    return access;
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

    const access = this.checkToolAccess(input.sessionId, input.toolName);
    if (!access.allowed) return access;

    const compaction = this.checkContextCompactionGate(
      input.sessionId,
      input.toolName,
      input.usage,
    );
    if (!compaction.allowed) return compaction;

    this.markToolCall(input.sessionId, input.toolName);
    this.trackToolCallStart({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    });
    return { allowed: true };
  }

  finishToolCall(input: FinishToolCallInput): string {
    const ledgerId = this.recordToolResult({
      sessionId: input.sessionId,
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      success: input.success,
      verdict: input.verdict,
      metadata: input.metadata,
    });
    this.trackToolCallEnd({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      success: input.success,
    });
    return ledgerId;
  }
}
