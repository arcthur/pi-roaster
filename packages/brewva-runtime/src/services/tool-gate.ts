import { randomUUID } from "node:crypto";
import type { SessionCostTracker } from "../cost/tracker.js";
import { TOOL_POSTURE_SELECTED_EVENT_TYPE } from "../events/event-types.js";
import {
  getToolGovernanceDescriptor,
  resolveToolInvocationPosture,
} from "../governance/tool-governance.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { resolveSecurityPolicy } from "../security/mode.js";
import { checkToolAccess as evaluateSkillToolAccess } from "../security/tool-policy.js";
import type {
  BrewvaEventRecord,
  ContextBudgetUsage,
  DecisionReceipt,
  PatchSet,
  ProposalEnvelope,
  SkillDocument,
  ToolInvocationPosture,
  ToolMutationReceipt,
} from "../types.js";
import { stableJsonStringify } from "../utils/json.js";
import { normalizeToolName } from "../utils/tool-name.js";
import { resolveToolResultVerdict } from "../utils/tool-result.js";
import type { ContextService } from "./context.js";
import type { EffectCommitmentDeskService } from "./effect-commitment-desk.js";
import type { ExplorationSupervisorService } from "./exploration-supervisor.js";
import type { FileChangeService } from "./file-change.js";
import type { LedgerService } from "./ledger.js";
import type { ProposalAdmissionService } from "./proposal-admission.js";
import type { ResourceLeaseService } from "./resource-lease.js";
import type { ReversibleMutationService } from "./reversible-mutation.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

export interface ToolAccessDecision {
  allowed: boolean;
  reason?: string;
  advisory?: string;
  posture?: ToolInvocationPosture;
  commitmentReceipt?: DecisionReceipt;
  effectCommitmentRequestId?: string;
  mutationReceipt?: ToolMutationReceipt;
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
  effectCommitmentRequestId?: string;
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
  proposalAdmissionService: Pick<ProposalAdmissionService, "submitProposal">;
  effectCommitmentDeskService: Pick<
    EffectCommitmentDeskService,
    "prepareResume" | "getRequestIdForProposal"
  >;
  reversibleMutationService: Pick<ReversibleMutationService, "prepare" | "record">;
  explorationSupervisorService: Pick<
    ExplorationSupervisorService,
    "checkToolCall" | "observeToolResult"
  >;
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
  }) => BrewvaEventRecord | undefined;
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
  }) => PatchSet | undefined;
  private readonly prepareMutation: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
  }) => ToolMutationReceipt | undefined;
  private readonly recordMutation: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    channelSuccess: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    patchSet?: PatchSet;
    metadata?: Record<string, unknown>;
  }) => void;
  private readonly checkExploration: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    posture: ToolInvocationPosture;
  }) => ToolAccessDecision;
  private readonly observeExplorationToolResult: (input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    verdict: "pass" | "fail" | "inconclusive";
    outputText: string;
    posture: ToolInvocationPosture;
  }) => void;
  private readonly submitProposal: (
    sessionId: string,
    proposal: ProposalEnvelope<"effect_commitment">,
  ) => DecisionReceipt;
  private readonly prepareEffectCommitmentResume: EffectCommitmentDeskService["prepareResume"];
  private readonly getEffectCommitmentRequestIdForProposal: (
    sessionId: string,
    proposalId: string,
  ) => string | undefined;

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
    this.submitProposal = (sessionId, proposal) =>
      options.proposalAdmissionService.submitProposal(sessionId, proposal);
    this.prepareEffectCommitmentResume = (input) =>
      options.effectCommitmentDeskService.prepareResume(input);
    this.getEffectCommitmentRequestIdForProposal = (sessionId, proposalId) =>
      options.effectCommitmentDeskService.getRequestIdForProposal(sessionId, proposalId);
    this.prepareMutation = (input) => options.reversibleMutationService.prepare(input);
    this.recordMutation = (input) => options.reversibleMutationService.record(input);
    this.checkExploration = (input) => options.explorationSupervisorService.checkToolCall(input);
    this.observeExplorationToolResult = (input) =>
      options.explorationSupervisorService.observeToolResult(input);
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

  private summarizeArgs(args: Record<string, unknown> | undefined): string | undefined {
    if (!args || Object.keys(args).length === 0) {
      return undefined;
    }
    try {
      const serialized = stableJsonStringify(args);
      if (!serialized) {
        return undefined;
      }
      if (serialized.length <= 240) {
        return serialized;
      }
      return `${serialized.slice(0, 237)}...`;
    } catch {
      return undefined;
    }
  }

  private buildCommitmentProposal(
    input: StartToolCallInput,
    posture: "commitment",
    evidenceEvent: BrewvaEventRecord,
  ): ProposalEnvelope<"effect_commitment"> | undefined {
    const normalizedToolName = normalizeToolName(input.toolName);
    const descriptor = getToolGovernanceDescriptor(normalizedToolName);
    if (!descriptor) {
      return undefined;
    }

    const createdAt = Date.now();
    return {
      id: [
        "effect-commitment",
        normalizedToolName,
        input.toolCallId.trim() || randomUUID(),
        String(createdAt),
      ].join(":"),
      kind: "effect_commitment",
      issuer: "brewva.runtime.tool-gate",
      subject: `tool:${normalizedToolName}`,
      payload: {
        toolName: normalizedToolName,
        toolCallId: input.toolCallId.trim(),
        posture,
        effects: [...descriptor.effects],
        defaultRisk: descriptor.defaultRisk,
        argsSummary: this.summarizeArgs(input.args),
      },
      evidenceRefs: [
        {
          id: evidenceEvent.id,
          sourceType: "event",
          locator: `event://${evidenceEvent.id}`,
          createdAt: evidenceEvent.timestamp,
        },
      ],
      createdAt,
    };
  }

  private authorizeCommitment(
    input: StartToolCallInput,
    evidenceEvent: BrewvaEventRecord | undefined,
  ): ToolAccessDecision {
    if (input.effectCommitmentRequestId) {
      const resumed = this.prepareEffectCommitmentResume({
        sessionId: input.sessionId,
        requestId: input.effectCommitmentRequestId,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        argsSummary: this.summarizeArgs(input.args),
      });
      if (!resumed.ok) {
        this.recordEvent({
          sessionId: input.sessionId,
          type: "tool_call_blocked",
          turn: this.getCurrentTurn(input.sessionId),
          payload: {
            toolName: normalizeToolName(input.toolName),
            reason: resumed.reason,
            requestId: resumed.requestId,
          },
        });
        return {
          allowed: false,
          posture: "commitment",
          reason: resumed.reason,
          effectCommitmentRequestId: resumed.requestId,
        };
      }

      const resumedReceipt = this.submitProposal(input.sessionId, resumed.proposal);
      if (resumedReceipt.decision !== "accept") {
        const reason =
          resumedReceipt.reasons.join(", ") ||
          `Commitment rejected for tool '${normalizeToolName(input.toolName)}'.`;
        this.recordEvent({
          sessionId: input.sessionId,
          type: "tool_call_blocked",
          turn: this.getCurrentTurn(input.sessionId),
          payload: {
            toolName: normalizeToolName(input.toolName),
            reason,
            decision: resumedReceipt.decision,
            proposalId: resumedReceipt.proposalId,
            requestId: resumed.requestId,
          },
        });
        return {
          allowed: false,
          posture: "commitment",
          reason,
          commitmentReceipt: resumedReceipt,
          effectCommitmentRequestId: resumed.requestId,
        };
      }

      return {
        allowed: true,
        posture: "commitment",
        commitmentReceipt: resumedReceipt,
        effectCommitmentRequestId: resumed.requestId,
      };
    }

    if (!evidenceEvent) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' is missing auditable evidence.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
        },
      });
      return {
        allowed: false,
        posture: "commitment",
        reason,
      };
    }

    const proposal = this.buildCommitmentProposal(input, "commitment", evidenceEvent);
    if (!proposal) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' is missing governance metadata.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
        },
      });
      return {
        allowed: false,
        posture: "commitment",
        reason,
      };
    }

    const receipt = this.submitProposal(input.sessionId, proposal);
    const effectCommitmentRequestId =
      receipt.decision === "defer"
        ? this.getEffectCommitmentRequestIdForProposal(input.sessionId, proposal.id)
        : undefined;
    if (receipt.decision !== "accept") {
      const reason =
        receipt.reasons.join(", ") ||
        `Commitment rejected for tool '${normalizeToolName(input.toolName)}'.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
          decision: receipt.decision,
          proposalId: receipt.proposalId,
          requestId: effectCommitmentRequestId ?? null,
        },
      });
      return {
        allowed: false,
        posture: "commitment",
        reason,
        commitmentReceipt: receipt,
        effectCommitmentRequestId,
      };
    }

    return {
      allowed: true,
      posture: "commitment",
      commitmentReceipt: receipt,
      effectCommitmentRequestId,
    };
  }

  startToolCall(input: StartToolCallInput): ToolAccessDecision {
    const posture = resolveToolInvocationPosture(input.toolName);
    const normalizedToolName = normalizeToolName(input.toolName);
    const descriptor = getToolGovernanceDescriptor(input.toolName);

    if (input.usage) {
      this.observeContextUsage(input.sessionId, input.usage);
    }

    const postureEvent = this.recordEvent({
      sessionId: input.sessionId,
      type: TOOL_POSTURE_SELECTED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolCallId: input.toolCallId,
        toolName: normalizedToolName,
        posture,
        effects: descriptor?.effects ?? [],
        defaultRisk: descriptor?.defaultRisk ?? null,
      },
    });

    if (input.recordLifecycleEvent) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          posture,
        },
      });
    }

    const gateDecision = this.evaluatePolicyPosture(input, posture, postureEvent);
    if (!gateDecision.allowed) return gateDecision;

    this.markToolCall(input.sessionId, input.toolName);
    this.trackToolCallStart({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    });
    const mutationReceipt =
      posture === "reversible_mutate"
        ? this.prepareMutation({
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          })
        : undefined;
    return {
      allowed: true,
      advisory: gateDecision.advisory,
      posture,
      commitmentReceipt: gateDecision.commitmentReceipt,
      effectCommitmentRequestId: gateDecision.effectCommitmentRequestId,
      mutationReceipt,
    };
  }

  private evaluatePolicyPosture(
    input: StartToolCallInput,
    posture: ToolInvocationPosture,
    postureEvent: BrewvaEventRecord | undefined,
  ): ToolAccessDecision {
    const access = this.checkToolAccess(input.sessionId, input.toolName);
    if (!access.allowed) {
      return {
        ...access,
        posture,
      };
    }

    const compaction = this.checkContextCompactionGate(
      input.sessionId,
      input.toolName,
      input.usage,
    );
    if (!compaction.allowed) {
      return {
        ...compaction,
        posture,
      };
    }

    const exploration = this.checkExploration({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      posture,
    });
    if (!exploration.allowed) {
      return {
        ...exploration,
        posture,
      };
    }

    if (posture === "commitment") {
      const commitment = this.authorizeCommitment(input, postureEvent);
      if (!commitment.allowed) {
        return commitment;
      }
      return {
        allowed: true,
        advisory: exploration.advisory,
        posture,
        commitmentReceipt: commitment.commitmentReceipt,
        effectCommitmentRequestId: commitment.effectCommitmentRequestId,
      };
    }

    return {
      allowed: true,
      advisory: exploration.advisory,
      posture,
    };
  }

  finishToolCall(input: FinishToolCallInput): string {
    const posture = resolveToolInvocationPosture(input.toolName);
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
    this.observeExplorationToolResult({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      verdict,
      outputText: input.outputText,
      posture,
    });
    const patchSet = this.trackToolCallEnd({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      channelSuccess: input.channelSuccess,
    });
    if (posture === "reversible_mutate") {
      this.recordMutation({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        channelSuccess: input.channelSuccess,
        verdict,
        patchSet,
        metadata: input.metadata,
      });
    }
    return ledgerId;
  }
}
