import { createRuntimeTelegramChannelBridge } from "@brewva/brewva-extensions";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  type ChannelTurnBridge,
  TurnWALRecovery,
  TurnWALStore,
  normalizeChannelId,
  type TurnEnvelope,
  type TurnPart,
} from "@brewva/brewva-runtime/channels";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { isOwnerAuthorized } from "./channel/acl.js";
import { AgentRegistry } from "./channel/agent-registry.js";
import { AgentRuntimeManager } from "./channel/agent-runtime-manager.js";
import { ApprovalRoutingStore } from "./channel/approval-routing.js";
import { ApprovalStateStore } from "./channel/approval-state.js";
import {
  createChannelA2AExtension,
  type ChannelA2AAdapter,
} from "./channel/channel-a2a-extension.js";
import { CommandRouter, type ChannelCommandMatch } from "./channel/command-router.js";
import { ChannelCoordinator } from "./channel/coordinator.js";
import type { AgentSessionUsage } from "./channel/eviction.js";
import { selectIdleEvictableAgentsByTtl, selectLruEvictableAgent } from "./channel/eviction.js";
import { resolveChannelOrchestrationConfig } from "./channel/orchestration-config.js";
import { buildAgentScopedConversationKey, buildRoutingScopeKey } from "./channel/routing-scope.js";
import { clampText, ensureSessionShutdownRecorded } from "./runtime-utils.js";
import { createBrewvaSession, type BrewvaSessionResult } from "./session.js";

export interface RunChannelModeOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  enableExtensions: boolean;
  verbose: boolean;
  channel: string;
  channelConfig?: ChannelModeConfig;
  onRuntimeReady?: (runtime: BrewvaRuntime) => void;
}

export interface TelegramChannelModeConfig {
  token?: string;
  callbackSecret?: string;
  pollTimeoutSeconds?: number;
  pollLimit?: number;
  pollRetryMs?: number;
}

export interface ChannelModeConfig {
  telegram?: TelegramChannelModeConfig;
}

interface ConversationSessionState {
  key: string;
  scopeKey: string;
  agentId: string;
  runtime: BrewvaRuntime;
  agentSessionId: string;
  result: BrewvaSessionResult;
  queueTail: Promise<void>;
  inFlightTasks: number;
  outboundSequence: number;
  lastUsedAt: number;
  lastTurn: TurnEnvelope;
}

interface ToolTurnOutput {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

interface PromptTurnOutputs {
  assistantText: string;
  toolOutputs: ToolTurnOutput[];
}

interface DispatchToAgentResult {
  ok: boolean;
  agentId: string;
  responseText: string;
  error?: string;
}

export const SUPPORTED_CHANNELS = ["telegram"] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];
const TELEGRAM_INTERACTIVE_SKILL_NAME = "telegram-interactive-components";

interface ChannelLaunchBundle {
  bridge: ChannelTurnBridge;
}

interface ChannelLauncherInput {
  runtime: BrewvaRuntime;
  channelConfig?: ChannelModeConfig;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  resolveIngestedSessionId?: (
    turn: TurnEnvelope,
  ) => Promise<string | undefined> | string | undefined;
  resolveApprovalState?: (params: {
    conversationId: string;
    requestId: string;
    actionId: string;
  }) =>
    | {
        screenId?: string;
        stateKey?: string;
        state?: unknown;
      }
    | null
    | undefined;
  persistApprovalState?: (params: {
    conversationId: string;
    requestId: string;
    snapshot: {
      screenId?: string;
      stateKey?: string;
      state?: unknown;
    };
  }) => void;
  persistApprovalRouting?: (params: {
    conversationId: string;
    requestId: string;
    agentId?: string;
    agentSessionId?: string;
    turnId?: string;
  }) => void;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function resolveSupportedChannel(raw: string): SupportedChannel | null {
  const normalized = normalizeChannelId(raw);
  return (SUPPORTED_CHANNELS as readonly string[]).includes(normalized)
    ? (normalized as SupportedChannel)
    : null;
}

function formatSupportedChannels(): string {
  return SUPPORTED_CHANNELS.join(", ");
}

function buildChannelSkillPolicyBlock(runtime: BrewvaRuntime, turn: TurnEnvelope): string {
  if (turn.channel !== "telegram") {
    return "";
  }

  const skill = runtime.skills.get(TELEGRAM_INTERACTIVE_SKILL_NAME);
  if (!skill) {
    return [
      "[Brewva Channel Skill Policy]",
      "Channel: telegram",
      `Preferred interactive skill '${TELEGRAM_INTERACTIVE_SKILL_NAME}' is not available in this runtime.`,
      "When interaction is required, emit plain-text fallback instructions only.",
    ].join("\n");
  }

  return [
    "[Brewva Channel Skill Policy]",
    "Channel: telegram",
    `Preferred interactive skill: ${skill.name}`,
    `Skill description: ${skill.description}`,
    `If interaction is needed, call tool 'skill_load' with name='${skill.name}' before composing output.`,
    "If interaction is not needed, reply normally.",
  ].join("\n");
}

const CHANNEL_LAUNCHERS: Record<
  SupportedChannel,
  (input: ChannelLauncherInput) => ChannelLaunchBundle
> = {
  telegram: (input) => {
    const telegram = input.channelConfig?.telegram;
    const telegramToken = normalizeText(telegram?.token);
    if (!telegramToken) {
      throw new Error("--telegram-token is required when --channel telegram is set.");
    }
    const callbackSecret = normalizeText(telegram?.callbackSecret) || undefined;
    return createRuntimeTelegramChannelBridge({
      runtime: input.runtime,
      token: telegramToken,
      adapter: {
        inbound: {
          callbackSecret,
          resolveApprovalState: input.resolveApprovalState,
        },
        outbound: {
          callbackSecret,
          persistApprovalState: input.persistApprovalState,
          persistApprovalRouting: input.persistApprovalRouting,
        },
      },
      transport: {
        poll: {
          timeoutSeconds: telegram?.pollTimeoutSeconds,
          limit: telegram?.pollLimit,
          retryDelayMs: telegram?.pollRetryMs,
        },
      },
      resolveIngestedSessionId: input.resolveIngestedSessionId,
      onInboundTurn: input.onInboundTurn,
      onAdapterError: input.onAdapterError,
    });
  },
};

function extractMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text.trim());
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  try {
    const serialized = JSON.stringify(result);
    return serialized && serialized !== "{}" ? serialized : "";
  } catch {
    return "";
  }
}

function asToolExecutionEndEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: unknown;
} | null {
  if (event.type !== "tool_execution_end") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    result?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
    isError: candidate.isError === true,
    result: candidate.result,
  };
}

function formatToolTurnOutput(input: {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: unknown;
}): ToolTurnOutput {
  const status = input.isError ? "failed" : "completed";
  const detail = clampText(extractToolResultText(input.result), 1200);
  const text = detail
    ? `Tool ${input.toolName} (${input.toolCallId}) ${status}\n${detail}`
    : `Tool ${input.toolName} (${input.toolCallId}) ${status}`;
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    isError: input.isError,
    text,
  };
}

function summarizeTurnPart(part: TurnPart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "image") {
    return `[image] ${part.uri}`;
  }
  const name = part.name ? ` (${part.name})` : "";
  return `[file${name}] ${part.uri}`;
}

function extractInboundText(turn: TurnEnvelope): string {
  const texts = turn.parts
    .filter((part): part is Extract<TurnPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0);
  return texts.join("\n").trim();
}

function buildInboundPrompt(turn: TurnEnvelope): string {
  const lines: string[] = [];
  const header = [`[channel:${turn.channel}]`, `conversation:${turn.conversationId}`];
  if (turn.threadId) {
    header.push(`thread:${turn.threadId}`);
  }
  lines.push(header.join(" "));
  lines.push(`turn_kind:${turn.kind}`);

  for (const part of turn.parts) {
    const text = summarizeTurnPart(part).trim();
    if (text) {
      lines.push(text);
    }
  }

  if (turn.kind === "approval" && turn.approval) {
    const actions = turn.approval.actions
      .map((action) => `${action.id} (${action.label})`)
      .join(", ");
    lines.push(`approval_request:${turn.approval.requestId}`);
    lines.push(`approval_title:${turn.approval.title}`);
    if (turn.approval.detail) {
      lines.push(`approval_detail:${turn.approval.detail}`);
    }
    if (actions) {
      lines.push(`approval_actions:${actions}`);
    }
  }

  return lines.join("\n").trim();
}

function buildOutboundTurn(input: {
  inbound: TurnEnvelope;
  kind: "assistant" | "tool";
  text: string;
  agentSessionId: string;
  sequence: number;
  meta?: Record<string, unknown>;
}): TurnEnvelope {
  const now = Date.now();
  return {
    schema: "brewva.turn.v1",
    kind: input.kind,
    sessionId: input.inbound.sessionId,
    turnId: `${input.inbound.turnId}:${input.kind}:${input.sequence}`,
    channel: input.inbound.channel,
    conversationId: input.inbound.conversationId,
    messageId: undefined,
    threadId: input.inbound.threadId,
    timestamp: now,
    parts: [{ type: "text", text: input.text }],
    meta: {
      inReplyToTurnId: input.inbound.turnId,
      agentSessionId: input.agentSessionId,
      generatedAt: now,
      ...input.meta,
    },
  };
}

function rewriteTurnText(turn: TurnEnvelope, text: string): TurnEnvelope {
  return {
    ...turn,
    parts: [{ type: "text", text }],
  };
}

function isControlCommand(match: ChannelCommandMatch): boolean {
  return (
    match.kind === "new-agent" ||
    match.kind === "del-agent" ||
    match.kind === "focus" ||
    match.kind === "run" ||
    match.kind === "discuss"
  );
}

function formatDispatchError(error: unknown): DispatchToAgentResult {
  return {
    ok: false,
    agentId: "unknown",
    responseText: "",
    error: toErrorMessage(error),
  };
}

export function canonicalizeInboundTurnSession(
  turn: TurnEnvelope,
  agentSessionId: string,
): TurnEnvelope {
  if (turn.sessionId === agentSessionId) {
    return turn;
  }
  return {
    ...turn,
    sessionId: agentSessionId,
    meta: {
      ...turn.meta,
      channelSessionId: turn.sessionId,
    },
  };
}

export async function collectPromptTurnOutputs(
  session: BrewvaSessionResult["session"],
  prompt: string,
): Promise<PromptTurnOutputs> {
  let latestAssistantText = "";
  const toolOutputs: ToolTurnOutput[] = [];
  const seenToolCallIds = new Set<string>();

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const toolEvent = asToolExecutionEndEvent(event);
    if (toolEvent) {
      if (seenToolCallIds.has(toolEvent.toolCallId)) {
        return;
      }
      seenToolCallIds.add(toolEvent.toolCallId);
      toolOutputs.push(formatToolTurnOutput(toolEvent));
      return;
    }

    if (event.type === "message_end") {
      const message = (event as { message?: unknown }).message;
      if (extractMessageRole(message) !== "assistant") return;
      const text = normalizeText(extractMessageText(message));
      if (text) {
        latestAssistantText = text;
      }
    }
  });

  try {
    await session.sendUserMessage(prompt);
    await session.agent.waitForIdle();
    return {
      assistantText: latestAssistantText,
      toolOutputs,
    };
  } finally {
    unsubscribe();
  }
}

async function waitForAllSettledWithTimeout(
  promises: Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) return;
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, timeoutMs));
  });
  await Promise.race([Promise.allSettled(promises).then(() => undefined), timeoutPromise]);
}

function combineOutputsForInternalDispatch(outputs: PromptTurnOutputs): string {
  const assistant = normalizeText(outputs.assistantText);
  if (assistant.length > 0) {
    return assistant;
  }
  const toolText = outputs.toolOutputs
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0)
    .join("\n\n");
  return toolText;
}

export async function runChannelMode(options: RunChannelModeOptions): Promise<void> {
  const channel = resolveSupportedChannel(options.channel);
  if (!channel) {
    console.error(
      `Error: unsupported channel "${options.channel}". Supported channels: ${formatSupportedChannels()}.`,
    );
    process.exitCode = 1;
    return;
  }

  const runtime = new BrewvaRuntime({
    cwd: options.cwd,
    configPath: options.configPath,
    agentId: options.agentId,
  });
  options.onRuntimeReady?.(runtime);

  const orchestrationConfig = resolveChannelOrchestrationConfig(runtime);
  const scopeStrategy = orchestrationConfig.enabled ? orchestrationConfig.scopeStrategy : "chat";

  const registry = await AgentRegistry.create({
    workspaceRoot: runtime.workspaceRoot,
  });
  const approvalRouting = ApprovalRoutingStore.create({
    workspaceRoot: runtime.workspaceRoot,
  });
  const approvalState = ApprovalStateStore.create({
    workspaceRoot: runtime.workspaceRoot,
  });
  const runtimeManager = new AgentRuntimeManager({
    controllerRuntime: runtime,
    maxLiveRuntimes: orchestrationConfig.limits.maxLiveRuntimes,
    idleRuntimeTtlMs: orchestrationConfig.limits.idleRuntimeTtlMs,
  });
  const commandRouter = new CommandRouter();

  const turnWalStore = new TurnWALStore({
    workspaceRoot: runtime.workspaceRoot,
    config: runtime.config.infrastructure.turnWal,
    scope: `channel-${channel}`,
    recordEvent: (input) => {
      runtime.events.record({
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        skipTapeCheckpoint: true,
      });
    },
  });
  const turnWalCompactIntervalMs = Math.max(
    30_000,
    Math.floor(runtime.config.infrastructure.turnWal.compactAfterMs / 2),
  );
  let turnWalCompactTimer: ReturnType<typeof setInterval> | null = null;

  const sessions = new Map<string, ConversationSessionState>();
  const sessionByAgentSessionId = new Map<string, ConversationSessionState>();
  const createSessionTasks = new Map<string, Promise<ConversationSessionState>>();
  const scopeQueues = new Map<string, Promise<void>>();
  const lastTurnByScope = new Map<string, TurnEnvelope>();
  let shuttingDown = false;

  let bundle: ChannelLaunchBundle;

  const nextControllerSequenceByScope = new Map<string, number>();
  const nextControllerSequence = (scopeKey: string): number => {
    const next = (nextControllerSequenceByScope.get(scopeKey) ?? 0) + 1;
    nextControllerSequenceByScope.set(scopeKey, next);
    return next;
  };

  const sendControllerReply = async (
    turn: TurnEnvelope,
    scopeKey: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const outbound = buildOutboundTurn({
      inbound: turn,
      kind: "assistant",
      text: trimmed,
      agentSessionId: `controller:${runtime.agentId}`,
      sequence: nextControllerSequence(scopeKey),
      meta,
    });
    try {
      await bundle.bridge.sendTurn(outbound);
    } catch (error) {
      runtime.events.record({
        sessionId: turn.sessionId,
        type: "channel_turn_outbound_error",
        payload: {
          turnId: turn.turnId,
          outboundKind: "assistant",
          agentSessionId: `controller:${runtime.agentId}`,
          agentId: runtime.agentId,
          scopeKey,
          error: toErrorMessage(error),
          isControllerReply: true,
        },
      });
    }
  };

  const enqueueSessionTask = async <T>(
    state: ConversationSessionState,
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = state.queueTail;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        state.inFlightTasks += 1;
        try {
          return await task();
        } finally {
          state.inFlightTasks = Math.max(0, state.inFlightTasks - 1);
        }
      });
    state.queueTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const disposeSessionState = async (state: ConversationSessionState): Promise<void> => {
    sessions.delete(state.key);
    sessionByAgentSessionId.delete(state.agentSessionId);
    try {
      await state.result.session.abort();
    } catch {
      // Best effort abort for shutdown and deletion cleanup.
    }
    ensureSessionShutdownRecorded(state.runtime, state.agentSessionId);
    try {
      state.runtime.session.clearState(state.agentSessionId);
    } catch {
      // Best effort cleanup.
    }
    state.result.session.dispose();
    runtimeManager.releaseRuntime(state.agentId);
  };

  const cleanupAgentSessions = async (agentId: string): Promise<void> => {
    const matches = [...sessions.values()].filter((state) => state.agentId === agentId);
    await Promise.all(
      matches.map(async (state) => {
        await waitForAllSettledWithTimeout([state.queueTail], 2000);
        await disposeSessionState(state);
      }),
    );
  };

  const buildSessionUsages = (): AgentSessionUsage[] =>
    [...sessions.values()].map((state) => ({
      agentId: state.agentId,
      lastUsedAt: state.lastUsedAt,
      inFlightTasks: state.inFlightTasks,
    }));

  const evictAgentRuntime = async (agentId: string): Promise<boolean> => {
    const matches = [...sessions.values()].filter((state) => state.agentId === agentId);
    await waitForAllSettledWithTimeout(
      matches.map((state) => state.queueTail),
      2000,
    );
    if (
      [...sessions.values()].some((state) => state.agentId === agentId && state.inFlightTasks > 0)
    ) {
      return false;
    }
    await cleanupAgentSessions(agentId);
    const disposed = runtimeManager.disposeRuntime(agentId);
    return disposed;
  };

  const evictIdleAgentRuntimesByTtl = async (now = Date.now()): Promise<string[]> => {
    const candidates = selectIdleEvictableAgentsByTtl(
      buildSessionUsages(),
      now,
      orchestrationConfig.limits.idleRuntimeTtlMs,
    );
    const evicted: string[] = [];
    for (const agentId of candidates) {
      const disposed = await evictAgentRuntime(agentId);
      if (disposed) {
        evicted.push(agentId);
      }
    }
    if (evicted.length > 0) {
      runtime.events.record({
        sessionId: turnWalStore.scope,
        type: "channel_runtime_evicted",
        payload: {
          agentIds: evicted,
          source: "idle_ttl_reclaim",
        },
        skipTapeCheckpoint: true,
      });
    }
    return evicted;
  };

  const evictLeastRecentlyUsedAgentRuntime = async (): Promise<string | null> => {
    const candidate = selectLruEvictableAgent(buildSessionUsages());
    if (!candidate) return null;
    const disposed = await evictAgentRuntime(candidate);
    if (!disposed) return null;
    runtime.events.record({
      sessionId: turnWalStore.scope,
      type: "channel_runtime_evicted",
      payload: {
        agentIds: [candidate],
        source: "capacity_reclaim",
      },
      skipTapeCheckpoint: true,
    });
    return candidate;
  };

  let coordinator: ChannelCoordinator;

  const a2aAdapter: ChannelA2AAdapter = {
    send: async (input) => {
      const result = await coordinator.a2aSend(input);
      runtime.events.record({
        sessionId: input.fromSessionId,
        type: result.ok ? "channel_a2a_invoked" : "channel_a2a_blocked",
        payload: {
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          depth: result.depth,
          hops: result.hops,
          correlationId: input.correlationId,
          error: result.error,
        },
      });
      return result;
    },
    broadcast: async (input) => {
      const result = await coordinator.a2aBroadcast(input);
      runtime.events.record({
        sessionId: input.fromSessionId,
        type: result.ok ? "channel_a2a_invoked" : "channel_a2a_blocked",
        payload: {
          fromAgentId: input.fromAgentId,
          toAgentIds: input.toAgentIds,
          correlationId: input.correlationId,
          ok: result.ok,
          error: result.error,
        },
      });
      return result;
    },
    listAgents: async (input) => {
      return coordinator.listAgents(input);
    },
  };

  const getOrCreateSession = async (
    scopeKey: string,
    agentId: string,
    turn: TurnEnvelope,
  ): Promise<ConversationSessionState> => {
    const key = buildAgentScopedConversationKey(agentId, scopeKey);
    const existing = sessions.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.lastTurn = turn;
      runtimeManager.touchRuntime(agentId);
      return existing;
    }

    const pending = createSessionTasks.get(key);
    if (pending) return pending;

    const created = (async () => {
      let workerRuntime: BrewvaRuntime | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          workerRuntime = await runtimeManager.getOrCreateRuntime(agentId);
          break;
        } catch (error) {
          if (toErrorMessage(error) !== "runtime_capacity_exhausted" || attempt > 0) {
            throw error;
          }
          const reclaimed = await evictLeastRecentlyUsedAgentRuntime();
          if (!reclaimed) {
            throw error;
          }
        }
      }
      if (!workerRuntime) {
        throw new Error("runtime_unavailable");
      }
      const model = registry.getModel(agentId) ?? options.model;
      const extensionFactory = createChannelA2AExtension({
        adapter: a2aAdapter,
      });
      const result = await createBrewvaSession({
        cwd: options.cwd,
        configPath: options.configPath,
        model,
        enableExtensions: options.enableExtensions,
        runtime: workerRuntime,
        extensionFactories: [extensionFactory],
      });
      runtimeManager.retainRuntime(agentId);
      const state: ConversationSessionState = {
        key,
        scopeKey,
        agentId,
        runtime: workerRuntime,
        agentSessionId: result.session.sessionManager.getSessionId(),
        result,
        queueTail: Promise.resolve(),
        inFlightTasks: 0,
        outboundSequence: 0,
        lastUsedAt: Date.now(),
        lastTurn: turn,
      };
      sessions.set(key, state);
      sessionByAgentSessionId.set(state.agentSessionId, state);
      workerRuntime.events.record({
        sessionId: state.agentSessionId,
        type: "channel_session_bound",
        payload: {
          channel: turn.channel,
          conversationId: turn.conversationId,
          channelConversationKey: key,
          scopeKey,
          agentId,
          channelTurnSessionId: turn.sessionId,
          agentSessionId: state.agentSessionId,
        },
      });
      return state;
    })();

    createSessionTasks.set(key, created);
    try {
      return await created;
    } finally {
      createSessionTasks.delete(key);
    }
  };

  const executePromptForAgent = async (input: {
    scopeKey: string;
    agentId: string;
    prompt: string;
    reason: "run" | "discuss" | "a2a";
    turn: TurnEnvelope;
    correlationId?: string;
    fromAgentId?: string;
    fromSessionId?: string;
    depth?: number;
    hops?: number;
  }): Promise<DispatchToAgentResult> => {
    try {
      const state = await getOrCreateSession(input.scopeKey, input.agentId, input.turn);
      const outputs = await enqueueSessionTask(state, async () => {
        state.lastUsedAt = Date.now();
        state.lastTurn = input.turn;
        runtimeManager.touchRuntime(state.agentId);
        return collectPromptTurnOutputs(state.result.session, input.prompt);
      });
      await registry.touchAgent(input.agentId, Date.now(), true);
      return {
        ok: true,
        agentId: input.agentId,
        responseText: combineOutputsForInternalDispatch(outputs),
      };
    } catch (error) {
      return {
        ...formatDispatchError(error),
        agentId: input.agentId,
      };
    }
  };

  const processUserTurnOnAgent = async (
    turn: TurnEnvelope,
    _walId: string,
    scopeKey: string,
    targetAgentId: string,
  ): Promise<void> => {
    const state = await getOrCreateSession(scopeKey, targetAgentId, turn);
    const canonicalTurn = canonicalizeInboundTurnSession(turn, state.agentSessionId);
    const prompt = [
      buildChannelSkillPolicyBlock(state.runtime, canonicalTurn),
      buildInboundPrompt(canonicalTurn),
    ]
      .filter((segment) => segment.trim().length > 0)
      .join("\n\n")
      .trim();

    if (!prompt) {
      return;
    }
    state.runtime.events.record({
      sessionId: canonicalTurn.sessionId,
      type: "channel_turn_dispatch_start",
      payload: {
        turnId: canonicalTurn.turnId,
        kind: canonicalTurn.kind,
        agentSessionId: state.agentSessionId,
        agentId: state.agentId,
      },
    });

    const outputs = await enqueueSessionTask(state, async () => {
      state.lastUsedAt = Date.now();
      state.lastTurn = canonicalTurn;
      runtimeManager.touchRuntime(state.agentId);
      return collectPromptTurnOutputs(state.result.session, prompt);
    });
    await registry.touchAgent(state.agentId, Date.now(), true);

    const assistantText = normalizeText(outputs.assistantText);
    let outboundTurnsSent = 0;

    state.runtime.events.record({
      sessionId: canonicalTurn.sessionId,
      type: "channel_turn_dispatch_end",
      payload: {
        turnId: canonicalTurn.turnId,
        kind: canonicalTurn.kind,
        agentSessionId: state.agentSessionId,
        agentId: state.agentId,
        assistantChars: assistantText.length,
        toolTurns: outputs.toolOutputs.length,
      },
    });

    for (const toolOutput of outputs.toolOutputs) {
      state.outboundSequence += 1;
      const toolTurn = buildOutboundTurn({
        inbound: canonicalTurn,
        kind: "tool",
        text: toolOutput.text,
        agentSessionId: state.agentSessionId,
        sequence: state.outboundSequence,
        meta: {
          toolCallId: toolOutput.toolCallId,
          toolName: toolOutput.toolName,
          toolError: toolOutput.isError,
          agentId: state.agentId,
        },
      });
      try {
        await bundle.bridge.sendTurn(toolTurn);
        outboundTurnsSent += 1;
      } catch (error) {
        state.runtime.events.record({
          sessionId: canonicalTurn.sessionId,
          type: "channel_turn_outbound_error",
          payload: {
            turnId: canonicalTurn.turnId,
            outboundKind: "tool",
            toolCallId: toolOutput.toolCallId,
            agentSessionId: state.agentSessionId,
            agentId: state.agentId,
            error: toErrorMessage(error),
          },
        });
      }
    }

    if (assistantText) {
      state.outboundSequence += 1;
      const assistantTurn = buildOutboundTurn({
        inbound: canonicalTurn,
        kind: "assistant",
        text: assistantText,
        agentSessionId: state.agentSessionId,
        sequence: state.outboundSequence,
        meta: {
          agentId: state.agentId,
        },
      });
      try {
        await bundle.bridge.sendTurn(assistantTurn);
        outboundTurnsSent += 1;
      } catch (error) {
        state.runtime.events.record({
          sessionId: canonicalTurn.sessionId,
          type: "channel_turn_outbound_error",
          payload: {
            turnId: canonicalTurn.turnId,
            outboundKind: "assistant",
            agentSessionId: state.agentSessionId,
            agentId: state.agentId,
            error: toErrorMessage(error),
          },
        });
      }
    }

    state.runtime.events.record({
      sessionId: canonicalTurn.sessionId,
      type: "channel_turn_outbound_complete",
      payload: {
        turnId: canonicalTurn.turnId,
        agentSessionId: state.agentSessionId,
        agentId: state.agentId,
        outboundTurnsSent,
        toolTurns: outputs.toolOutputs.length,
        hasAssistantTurn: assistantText.length > 0,
      },
    });
  };

  coordinator = new ChannelCoordinator({
    limits: {
      fanoutMaxAgents: orchestrationConfig.limits.fanoutMaxAgents,
      maxDiscussionRounds: orchestrationConfig.limits.maxDiscussionRounds,
      a2aMaxDepth: orchestrationConfig.limits.a2aMaxDepth,
      a2aMaxHops: orchestrationConfig.limits.a2aMaxHops,
    },
    dispatch: async (input) => {
      const sourceState = input.fromSessionId
        ? sessionByAgentSessionId.get(input.fromSessionId)
        : undefined;
      const scopeKey = input.scopeKey ?? sourceState?.scopeKey;
      const turn = sourceState?.lastTurn ?? (scopeKey ? lastTurnByScope.get(scopeKey) : undefined);
      if (!scopeKey || !turn) {
        return {
          ok: false,
          agentId: input.agentId,
          responseText: "",
          error: "dispatch_scope_unavailable",
        };
      }
      return executePromptForAgent({
        scopeKey,
        agentId: input.agentId,
        prompt: input.task,
        reason: input.reason,
        turn,
        correlationId: input.correlationId,
        fromAgentId: input.fromAgentId,
        fromSessionId: input.fromSessionId,
        depth: input.depth,
        hops: input.hops,
      });
    },
    isAgentActive: (agentId) => registry.isActive(agentId),
    listAgents: ({ includeDeleted } = {}) =>
      registry.list({ includeDeleted }).map((entry) => ({
        agentId: entry.agentId,
        status: entry.status,
      })),
    resolveAgentBySessionId: (sessionId) => sessionByAgentSessionId.get(sessionId)?.agentId,
    forbidSelfA2A: true,
  });

  const renderAgentsSnapshot = (scopeKey: string): string => {
    const snapshot = registry.snapshot(scopeKey, true);
    const lines: string[] = [
      `Focus: @${snapshot.focusedAgentId}`,
      `Default: @${snapshot.defaultAgentId}`,
      "Agents:",
    ];

    const aggregateByAgent = new Map<
      string,
      {
        totalTokens: number;
        totalCostUsd: number;
      }
    >();
    for (const state of sessions.values()) {
      const summary = state.runtime.cost.getSummary(state.agentSessionId);
      const aggregate = aggregateByAgent.get(state.agentId) ?? { totalTokens: 0, totalCostUsd: 0 };
      aggregate.totalTokens += summary.totalTokens;
      aggregate.totalCostUsd += summary.totalCostUsd;
      aggregateByAgent.set(state.agentId, aggregate);
    }

    let workspaceTokens = 0;
    let workspaceCostUsd = 0;

    for (const agent of snapshot.agents) {
      const cost = aggregateByAgent.get(agent.agentId) ?? { totalTokens: 0, totalCostUsd: 0 };
      workspaceTokens += cost.totalTokens;
      workspaceCostUsd += cost.totalCostUsd;
      const focused = agent.isFocused ? " [focused]" : "";
      const deleted = agent.status === "deleted" ? " [deleted]" : "";
      const lastActive = agent.lastActiveAt ? ` lastActive=${agent.lastActiveAt}` : "";
      const model = agent.model ? ` model=${agent.model}` : "";
      lines.push(
        `- @${agent.agentId}${focused}${deleted}${model}${lastActive} tokens=${cost.totalTokens} cost=$${cost.totalCostUsd.toFixed(
          4,
        )}`,
      );
    }

    const runtimes = runtimeManager.listRuntimes();
    lines.push(
      `Runtime pool: live=${runtimes.length}/${runtimeManager.maxLiveRuntimes} idleTtlMs=${runtimeManager.idleRuntimeTtlMs}`,
    );
    lines.push(
      `Workspace active-session cost: tokens=${workspaceTokens} cost=$${workspaceCostUsd.toFixed(
        4,
      )} active_sessions=${sessions.size}`,
    );

    runtime.events.record({
      sessionId: turnWalStore.scope,
      type: "channel_workspace_cost_summary",
      payload: {
        scopeKey,
        activeSessions: sessions.size,
        totalTokens: workspaceTokens,
        totalCostUsd: workspaceCostUsd,
      },
      skipTapeCheckpoint: true,
    });

    return lines.join("\n");
  };

  const handleCommand = async (
    match: ChannelCommandMatch,
    turn: TurnEnvelope,
    scopeKey: string,
  ): Promise<{ handled: boolean; routeAgentId?: string; routeTask?: string }> => {
    if (match.kind === "none") {
      return { handled: false };
    }

    runtime.events.record({
      sessionId: turn.sessionId,
      type: "channel_command_received",
      payload: {
        scopeKey,
        command: match.kind,
        turnId: turn.turnId,
        conversationId: turn.conversationId,
      },
    });

    if (match.kind === "error") {
      await sendControllerReply(turn, scopeKey, `Command parse error: ${match.message}`);
      return { handled: true };
    }

    if (match.kind === "route-agent") {
      if (!registry.isActive(match.agentId)) {
        // Avoid swallowing normal Telegram mentions when the target isn't an orchestrated agent.
        return { handled: false };
      }

      await registry.setFocus(scopeKey, match.agentId);
      runtime.events.record({
        sessionId: turn.sessionId,
        type: "channel_focus_changed",
        payload: {
          scopeKey,
          agentId: match.agentId,
          source: "mention",
        },
      });
      return {
        handled: false,
        routeAgentId: match.agentId,
        routeTask: match.task,
      };
    }

    if (isControlCommand(match)) {
      const authorized = isOwnerAuthorized(
        turn,
        orchestrationConfig.owners.telegram,
        orchestrationConfig.aclModeWhenOwnersEmpty,
      );
      if (!authorized) {
        runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_command_rejected",
          payload: {
            scopeKey,
            command: match.kind,
            reason: "owner_acl_denied",
            turnId: turn.turnId,
          },
        });
        await sendControllerReply(turn, scopeKey, "Command denied: owner permission required.");
        return { handled: true };
      }
    }

    if (match.kind === "agents") {
      await sendControllerReply(turn, scopeKey, renderAgentsSnapshot(scopeKey));
      return { handled: true };
    }

    if (match.kind === "new-agent") {
      try {
        const created = await registry.createAgent({
          requestedAgentId: match.agentId,
          model: match.model,
        });
        runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_agent_created",
          payload: {
            scopeKey,
            agentId: created.agentId,
            model: created.model,
          },
        });
        await sendControllerReply(
          turn,
          scopeKey,
          `Created agent @${created.agentId}${created.model ? ` (model=${created.model})` : ""}.`,
        );
      } catch (error) {
        await sendControllerReply(
          turn,
          scopeKey,
          `Failed to create agent: ${toErrorMessage(error)}`,
        );
      }
      return { handled: true };
    }

    if (match.kind === "del-agent") {
      try {
        const existing = registry.get(match.agentId);
        if (!existing || existing.status !== "active") {
          throw new Error(`agent_not_found:${match.agentId}`);
        }
        if (existing.agentId === registry.defaultAgentId) {
          throw new Error("cannot_delete_default");
        }
        await cleanupAgentSessions(match.agentId);
        runtimeManager.disposeRuntime(match.agentId);
        await registry.softDeleteAgent(match.agentId);
        runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_agent_deleted",
          payload: {
            scopeKey,
            agentId: match.agentId,
          },
        });
        await sendControllerReply(turn, scopeKey, `Deleted agent @${match.agentId} (soft delete).`);
      } catch (error) {
        await sendControllerReply(
          turn,
          scopeKey,
          `Failed to delete agent: ${toErrorMessage(error)}`,
        );
      }
      return { handled: true };
    }

    if (match.kind === "focus") {
      try {
        const focused = await registry.setFocus(scopeKey, match.agentId);
        runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_focus_changed",
          payload: {
            scopeKey,
            agentId: focused,
            source: "command",
          },
        });
        await sendControllerReply(turn, scopeKey, `Focus set to @${focused}.`);
      } catch (error) {
        await sendControllerReply(turn, scopeKey, `Failed to set focus: ${toErrorMessage(error)}`);
      }
      return { handled: true };
    }

    if (match.kind === "run") {
      runtime.events.record({
        sessionId: turn.sessionId,
        type: "channel_fanout_started",
        payload: {
          scopeKey,
          targets: match.agentIds,
        },
      });
      const result = await coordinator.fanOut({
        agentIds: match.agentIds,
        task: match.task,
        scopeKey,
      });
      const lines = [
        result.ok ? "Fan-out completed." : `Fan-out failed: ${result.error ?? "unknown_error"}`,
        ...result.results.map((entry) =>
          entry.ok
            ? `- @${entry.agentId}: ${entry.responseText || "(empty)"}`
            : `- @${entry.agentId}: ERROR ${entry.error ?? "unknown_error"}`,
        ),
      ];
      runtime.events.record({
        sessionId: turn.sessionId,
        type: "channel_fanout_finished",
        payload: {
          scopeKey,
          targets: match.agentIds,
          ok: result.ok,
          error: result.error,
        },
      });
      await sendControllerReply(turn, scopeKey, lines.join("\n"));
      return { handled: true };
    }

    if (match.kind === "discuss") {
      const discussion = await coordinator.discuss({
        agentIds: match.agentIds,
        topic: match.topic,
        maxRounds: match.maxRounds,
        scopeKey,
      });
      const lines = [
        discussion.ok
          ? `Discussion completed (stoppedEarly=${discussion.stoppedEarly}).`
          : `Discussion failed: ${discussion.reason ?? "unknown_error"}`,
      ];
      for (const round of discussion.rounds) {
        runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_discussion_round",
          payload: {
            scopeKey,
            round: round.round,
            agentId: round.agentId,
          },
        });
        lines.push(`- r${round.round} @${round.agentId}: ${round.responseText || "(empty)"}`);
      }
      await sendControllerReply(turn, scopeKey, lines.join("\n"));
      return { handled: true };
    }

    return { handled: false };
  };

  const resolveApprovalTargetAgentId = (turn: TurnEnvelope): string | undefined => {
    if (!orchestrationConfig.enabled) return undefined;
    if (turn.kind !== "approval") return undefined;
    const requestId = turn.approval?.requestId?.trim() ?? "";
    if (!requestId) return undefined;
    const mapped = approvalRouting.resolveAgentId(turn.conversationId, requestId);
    if (mapped && registry.isActive(mapped)) {
      return mapped;
    }
    return undefined;
  };

  const processInboundTurn = async (
    turn: TurnEnvelope,
    walId: string,
    scopeKey: string,
  ): Promise<void> => {
    turnWalStore.markInflight(walId);
    lastTurnByScope.set(scopeKey, turn);

    try {
      const text = extractInboundText(turn);
      let commandResult: ChannelCommandMatch = { kind: "none" };
      if (orchestrationConfig.enabled && turn.kind === "user" && text.length > 0) {
        commandResult = commandRouter.match(text);
      }

      if (orchestrationConfig.enabled && commandResult.kind !== "none") {
        let commandOutcome: Awaited<ReturnType<typeof handleCommand>>;
        try {
          commandOutcome = await handleCommand(commandResult, turn, scopeKey);
        } catch (error) {
          runtime.events.record({
            sessionId: turn.sessionId,
            type: "channel_command_rejected",
            payload: {
              scopeKey,
              command: commandResult.kind,
              reason: "command_execution_error",
              turnId: turn.turnId,
              error: toErrorMessage(error),
            },
          });
          await sendControllerReply(turn, scopeKey, `Command failed: ${toErrorMessage(error)}`, {
            command: commandResult.kind,
          });
          turnWalStore.markDone(walId);
          return;
        }
        if (commandOutcome.handled) {
          turnWalStore.markDone(walId);
          return;
        }

        const routeAgentId = commandOutcome.routeAgentId;
        if (routeAgentId && commandOutcome.routeTask) {
          const rewrittenTurn = rewriteTurnText(turn, commandOutcome.routeTask);
          await processUserTurnOnAgent(rewrittenTurn, walId, scopeKey, routeAgentId);
          turnWalStore.markDone(walId);
          return;
        }
      }

      const fallbackAgentId = orchestrationConfig.enabled
        ? (resolveApprovalTargetAgentId(turn) ?? registry.resolveFocus(scopeKey))
        : runtime.agentId;
      await processUserTurnOnAgent(turn, walId, scopeKey, fallbackAgentId);
      turnWalStore.markDone(walId);
    } catch (error) {
      turnWalStore.markFailed(walId, toErrorMessage(error));
      throw error;
    }
  };

  const enqueueInboundTurn = async (
    turn: TurnEnvelope,
    enqueueOptions: {
      walId?: string;
      awaitCompletion?: boolean;
    } = {},
  ): Promise<void> => {
    if (shuttingDown) return;

    const walId =
      enqueueOptions.walId ??
      turnWalStore.appendPending(turn, "channel", {
        dedupeKey: `${turn.channel}:${turn.turnId}`,
      }).walId;

    const scopeKey = buildRoutingScopeKey(turn, scopeStrategy);
    const previous = scopeQueues.get(scopeKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await processInboundTurn(turn, walId, scopeKey);
      });
    scopeQueues.set(
      scopeKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );

    if (enqueueOptions.awaitCompletion) {
      await next;
    }
  };

  try {
    bundle = CHANNEL_LAUNCHERS[channel]({
      runtime,
      channelConfig: options.channelConfig,
      resolveApprovalState: (params) => {
        return approvalState.resolve(params);
      },
      persistApprovalState: (params) => {
        const result = approvalState.record({
          conversationId: params.conversationId,
          requestId: params.requestId,
          snapshot: params.snapshot,
        });
        if (!result.ok) return;
        const resolvedStateKey = result.snapshot?.stateKey ?? params.snapshot.stateKey;
        runtime.events.record({
          sessionId: turnWalStore.scope,
          type: "channel_approval_state_persisted",
          payload: {
            conversationId: params.conversationId,
            requestId: params.requestId,
            stateKey: resolvedStateKey ?? null,
            hasStateKey: Boolean(resolvedStateKey),
            hasState: params.snapshot.state !== undefined,
            storedState: result.storedState === true,
            generatedStateKey: result.generatedStateKey === true,
          },
          skipTapeCheckpoint: true,
        });
      },
      persistApprovalRouting: (params) => {
        if (!orchestrationConfig.enabled) return;
        approvalRouting.record({
          conversationId: params.conversationId,
          requestId: params.requestId,
          agentId: params.agentId,
          agentSessionId: params.agentSessionId,
          turnId: params.turnId,
        });
        runtime.events.record({
          sessionId: turnWalStore.scope,
          type: "channel_approval_routing_persisted",
          payload: {
            conversationId: params.conversationId,
            requestId: params.requestId,
            agentId: params.agentId,
            agentSessionId: params.agentSessionId,
            turnId: params.turnId,
          },
          skipTapeCheckpoint: true,
        });
      },
      resolveIngestedSessionId: (turn) => {
        const scopeKey = buildRoutingScopeKey(turn, scopeStrategy);
        let targetAgentId = orchestrationConfig.enabled
          ? registry.resolveFocus(scopeKey)
          : runtime.agentId;

        if (orchestrationConfig.enabled) {
          const approvalAgentId = resolveApprovalTargetAgentId(turn);
          if (approvalAgentId) {
            targetAgentId = approvalAgentId;
          }
        }

        if (orchestrationConfig.enabled && turn.kind === "user") {
          const text = extractInboundText(turn);
          const matched: ChannelCommandMatch =
            text.length > 0 ? commandRouter.match(text) : { kind: "none" };
          if (matched.kind === "route-agent") {
            if (registry.isActive(matched.agentId)) {
              targetAgentId = matched.agentId;
            }
          }
        }

        const key = buildAgentScopedConversationKey(targetAgentId, scopeKey);
        return sessions.get(key)?.agentSessionId;
      },
      onInboundTurn: async (turn) => {
        await enqueueInboundTurn(turn);
      },
      onAdapterError: async (error) => {
        if (options.verbose) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[channel:${channel}:error] ${message}`);
        }
      },
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const recovery = new TurnWALRecovery({
    workspaceRoot: runtime.workspaceRoot,
    config: runtime.config.infrastructure.turnWal,
    scopeFilter: (scope) => scope === turnWalStore.scope,
    recordEvent: (input) => {
      runtime.events.record({
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        skipTapeCheckpoint: true,
      });
    },
    handlers: {
      channel: async ({ record }) => {
        await enqueueInboundTurn(record.envelope, { walId: record.walId });
      },
    },
  });
  await recovery.recover();
  turnWalStore.compact();
  if (turnWalStore.isEnabled) {
    turnWalCompactTimer = setInterval(() => {
      void (async () => {
        try {
          turnWalStore.compact();
          await evictIdleAgentRuntimesByTtl(Date.now());
          const evicted = runtimeManager.evictIdleRuntimes(Date.now());
          if (evicted.length > 0) {
            runtime.events.record({
              sessionId: turnWalStore.scope,
              type: "channel_runtime_evicted",
              payload: {
                agentIds: evicted,
                source: "runtime_idle_reclaim",
              },
              skipTapeCheckpoint: true,
            });
          }
        } catch (error) {
          if (options.verbose) {
            console.error(`[channel:${channel}:wal] compact failed: ${toErrorMessage(error)}`);
          }
        }
      })();
    }, turnWalCompactIntervalMs);
    turnWalCompactTimer.unref?.();
  }

  await bundle.bridge.start();
  if (options.verbose) {
    console.error(`[channel] ${channel} bridge started`);
  }

  await new Promise<void>((complete) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      shuttingDown = true;

      void (async () => {
        if (options.verbose) {
          console.error(`[channel] received ${signal}, stopping...`);
        }
        if (turnWalCompactTimer) {
          clearInterval(turnWalCompactTimer);
          turnWalCompactTimer = null;
        }
        await bundle.bridge.stop();
        await waitForAllSettledWithTimeout(
          [...scopeQueues.values(), ...[...sessions.values()].map((state) => state.queueTail)],
          runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs,
        );

        await Promise.allSettled(
          [...sessions.values()].map(async (state) => {
            await disposeSessionState(state);
          }),
        );
        runtimeManager.disposeAll();

        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        if (options.verbose) {
          console.error("[channel] shutdown completed");
        }
        complete();
      })();
    };

    const onSigInt = (): void => shutdown("SIGINT");
    const onSigTerm = (): void => shutdown("SIGTERM");
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
  });
}
