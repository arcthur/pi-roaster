import { createRuntimeTelegramChannelBridge } from "@brewva/brewva-extensions";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  type ChannelTurnBridge,
  TurnWALRecovery,
  TurnWALStore,
  buildRawConversationKey,
  normalizeChannelId,
  type TurnEnvelope,
  type TurnPart,
} from "@brewva/brewva-runtime/channels";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { clampText, ensureSessionShutdownRecorded } from "./runtime-utils.js";
import { createBrewvaSession, type BrewvaSessionResult } from "./session.js";

export interface RunChannelModeOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
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
  agentSessionId: string;
  result: BrewvaSessionResult;
  queueTail: Promise<void>;
  outboundSequence: number;
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

export const SUPPORTED_CHANNELS = ["telegram"] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

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
        },
        outbound: {
          callbackSecret,
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
  });
  options.onRuntimeReady?.(runtime);
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
  const createSessionTasks = new Map<string, Promise<ConversationSessionState>>();
  let shuttingDown = false;

  const getOrCreateSession = async (turn: TurnEnvelope): Promise<ConversationSessionState> => {
    const key = buildRawConversationKey(turn.channel, turn.conversationId);
    const existing = sessions.get(key);
    if (existing) return existing;

    const pending = createSessionTasks.get(key);
    if (pending) return pending;

    const created = (async () => {
      const result = await createBrewvaSession({
        cwd: options.cwd,
        configPath: options.configPath,
        model: options.model,
        enableExtensions: options.enableExtensions,
        runtime,
      });
      const state: ConversationSessionState = {
        agentSessionId: result.session.sessionManager.getSessionId(),
        result,
        queueTail: Promise.resolve(),
        outboundSequence: 0,
      };
      sessions.set(key, state);
      runtime.events.record({
        sessionId: state.agentSessionId,
        type: "channel_session_bound",
        payload: {
          channel: turn.channel,
          conversationId: turn.conversationId,
          channelConversationKey: key,
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

  const processInboundTurn = async (
    state: ConversationSessionState,
    turn: TurnEnvelope,
    walId: string,
  ): Promise<void> => {
    turnWalStore.markInflight(walId);
    try {
      const canonicalTurn = canonicalizeInboundTurnSession(turn, state.agentSessionId);
      const prompt = buildInboundPrompt(canonicalTurn);
      if (!prompt) {
        turnWalStore.markDone(walId);
        return;
      }

      runtime.events.record({
        sessionId: canonicalTurn.sessionId,
        type: "channel_turn_dispatch_start",
        payload: {
          turnId: canonicalTurn.turnId,
          kind: canonicalTurn.kind,
          agentSessionId: state.agentSessionId,
        },
      });

      const outputs = await collectPromptTurnOutputs(state.result.session, prompt);
      const assistantText = normalizeText(outputs.assistantText);
      let outboundTurnsSent = 0;

      runtime.events.record({
        sessionId: canonicalTurn.sessionId,
        type: "channel_turn_dispatch_end",
        payload: {
          turnId: canonicalTurn.turnId,
          kind: canonicalTurn.kind,
          agentSessionId: state.agentSessionId,
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
          },
        });
        try {
          await bundle.bridge.sendTurn(toolTurn);
          outboundTurnsSent += 1;
        } catch (error) {
          runtime.events.record({
            sessionId: canonicalTurn.sessionId,
            type: "channel_turn_outbound_error",
            payload: {
              turnId: canonicalTurn.turnId,
              outboundKind: "tool",
              toolCallId: toolOutput.toolCallId,
              agentSessionId: state.agentSessionId,
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
        });
        try {
          await bundle.bridge.sendTurn(assistantTurn);
          outboundTurnsSent += 1;
        } catch (error) {
          runtime.events.record({
            sessionId: canonicalTurn.sessionId,
            type: "channel_turn_outbound_error",
            payload: {
              turnId: canonicalTurn.turnId,
              outboundKind: "assistant",
              agentSessionId: state.agentSessionId,
              error: toErrorMessage(error),
            },
          });
        }
      }

      runtime.events.record({
        sessionId: canonicalTurn.sessionId,
        type: "channel_turn_outbound_complete",
        payload: {
          turnId: canonicalTurn.turnId,
          agentSessionId: state.agentSessionId,
          outboundTurnsSent,
          toolTurns: outputs.toolOutputs.length,
          hasAssistantTurn: assistantText.length > 0,
        },
      });
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

    let state: ConversationSessionState;
    try {
      state = await getOrCreateSession(turn);
    } catch (error) {
      turnWalStore.markFailed(walId, toErrorMessage(error));
      throw error;
    }

    const previous = state.queueTail;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await processInboundTurn(state, turn, walId);
      });
    state.queueTail = next.catch(() => undefined);
    if (enqueueOptions.awaitCompletion) {
      await next;
    }
  };

  let bundle: ChannelLaunchBundle;
  try {
    bundle = CHANNEL_LAUNCHERS[channel]({
      runtime,
      channelConfig: options.channelConfig,
      resolveIngestedSessionId: (turn) => {
        const key = buildRawConversationKey(turn.channel, turn.conversationId);
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
      try {
        turnWalStore.compact();
      } catch (error) {
        if (options.verbose) {
          console.error(`[channel:${channel}:wal] compact failed: ${toErrorMessage(error)}`);
        }
      }
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
          [...sessions.values()].map((state) => state.queueTail),
          runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs,
        );
        await Promise.allSettled(
          [...sessions.values()].map(async (state) => {
            try {
              await state.result.session.abort();
            } catch {
              // Best effort abort during channel shutdown.
            }
            ensureSessionShutdownRecorded(runtime, state.agentSessionId);
            state.result.session.dispose();
          }),
        );
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
