import type { Server } from "node:http";
import { TelegramWebhookTransport } from "@brewva/brewva-channels-telegram";
import { createTelegramIngressServer, type TelegramIngressAuth } from "@brewva/brewva-ingress";
import { BrewvaRuntime, createTrustedLocalGovernancePort } from "@brewva/brewva-runtime";
import {
  type ChannelTurnBridge,
  TurnWALRecovery,
  TurnWALStore,
  normalizeChannelId,
  type TurnEnvelope,
  type TurnPart,
} from "@brewva/brewva-runtime/channels";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { AddonHost } from "../addons/host.js";
import { ConversationBindingStore } from "../conversations/binding-store.js";
import { createHostedSession, type HostedSessionResult } from "../host/create-hosted-session.js";
import {
  createRuntimeTelegramChannelBridge,
  resolveToolDisplayStatus,
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
  type ToolDisplayVerdict,
} from "../runtime-plugins/index.js";
import { sendPromptWithCompactionRecovery } from "../session/compaction-recovery.js";
import { clampText, ensureSessionShutdownRecorded } from "../utils/runtime.js";
import { isOwnerAuthorized } from "./acl.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { ApprovalRoutingStore } from "./approval-routing.js";
import { ApprovalStateStore } from "./approval-state.js";
import { createChannelA2AExtension, type ChannelA2AAdapter } from "./channel-a2a-extension.js";
import { CommandRouter, type ChannelCommandMatch } from "./command-router.js";
import { ChannelCoordinator } from "./coordinator.js";
import type { AgentSessionUsage } from "./eviction.js";
import { selectIdleEvictableAgentsByTtl, selectLruEvictableAgent } from "./eviction.js";
import { resolveChannelOrchestrationConfig } from "./orchestration-config.js";
import { buildAgentScopedConversationKey, buildRoutingScopeKey } from "./routing-scope.js";
import {
  buildChannelSkillPolicyBlock,
  resolveTelegramChannelSkillPolicyState,
  type TelegramChannelSkillPolicyState,
} from "./skill-policy.js";

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
  shutdownSignal?: AbortSignal;
  dependencies?: RunChannelModeDependencies;
}

export interface TelegramChannelModeConfig {
  token?: string;
  apiBaseUrl?: string;
  callbackSecret?: string;
  pollTimeoutSeconds?: number;
  pollLimit?: number;
  pollRetryMs?: number;
  webhook?: TelegramWebhookIngressModeConfig;
}

export interface TelegramWebhookIngressModeConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
  authMode?: "hmac" | "bearer" | "both";
  bearerToken?: string;
  hmacSecret?: string;
  hmacMaxSkewMs?: number;
  hmacNonceTtlMs?: number;
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
  result: HostedSessionResult;
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
  verdict: ToolDisplayVerdict;
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

export interface ChannelModeLaunchBundle {
  bridge: ChannelTurnBridge;
  onStart?: () => Promise<void>;
  onStop?: () => Promise<void>;
}

export interface ChannelModeLauncherInput {
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

export type ChannelModeLauncher = (input: ChannelModeLauncherInput) => ChannelModeLaunchBundle;

export interface RunChannelModeDependencies {
  createSession?: (
    options?: Parameters<typeof createHostedSession>[0],
  ) => Promise<HostedSessionResult>;
  collectPromptTurnOutputs?: (
    session: HostedSessionResult["session"],
    prompt: string,
  ) => Promise<PromptTurnOutputs>;
  launchers?: Partial<Record<SupportedChannel, ChannelModeLauncher>>;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

const TELEGRAM_WEBHOOK_ENABLED_ENV = "BREWVA_TELEGRAM_WEBHOOK_ENABLED";
const TELEGRAM_WEBHOOK_HOST_ENV = "BREWVA_TELEGRAM_INGRESS_HOST";
const TELEGRAM_WEBHOOK_PORT_ENV = "BREWVA_TELEGRAM_INGRESS_PORT";
const TELEGRAM_WEBHOOK_PATH_ENV = "BREWVA_TELEGRAM_INGRESS_PATH";
const TELEGRAM_WEBHOOK_MAX_BODY_BYTES_ENV = "BREWVA_TELEGRAM_INGRESS_MAX_BODY_BYTES";
const TELEGRAM_WEBHOOK_AUTH_MODE_ENV = "BREWVA_TELEGRAM_INGRESS_AUTH_MODE";
const TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV = "BREWVA_TELEGRAM_INGRESS_BEARER_TOKEN";
const TELEGRAM_WEBHOOK_HMAC_SECRET_ENV = "BREWVA_TELEGRAM_INGRESS_HMAC_SECRET";
const TELEGRAM_WEBHOOK_HMAC_MAX_SKEW_MS_ENV = "BREWVA_TELEGRAM_INGRESS_HMAC_MAX_SKEW_MS";
const TELEGRAM_WEBHOOK_HMAC_NONCE_TTL_MS_ENV = "BREWVA_TELEGRAM_INGRESS_NONCE_TTL_MS";
const TELEGRAM_WEBHOOK_DEFAULT_HOST = "0.0.0.0";
const TELEGRAM_WEBHOOK_DEFAULT_PORT = 8787;
const TELEGRAM_WEBHOOK_DEFAULT_PATH = "/ingest/telegram";
const TELEGRAM_API_BASE_URL_ENV = "BREWVA_TELEGRAM_API_BASE_URL";

export interface ResolvedTelegramWebhookIngressConfig {
  host: string;
  port: number;
  path: string;
  maxBodyBytes?: number;
  auth: TelegramIngressAuth;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseOptionalInteger(
  value: number | string | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  value: number | string | undefined,
  fieldName: string,
): number | undefined {
  const parsed = parseOptionalInteger(value, fieldName);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be > 0`);
  }
  return parsed;
}

function resolveTelegramWebhookAuth(input: {
  config: TelegramWebhookIngressModeConfig | undefined;
  env: NodeJS.ProcessEnv;
}): TelegramIngressAuth {
  const authModeRaw = normalizeOptionalText(
    input.config?.authMode ?? input.env[TELEGRAM_WEBHOOK_AUTH_MODE_ENV],
  );
  const authMode = authModeRaw?.toLowerCase();
  const bearerToken = normalizeOptionalText(
    input.config?.bearerToken ?? input.env[TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV],
  );
  const hmacSecret = normalizeOptionalText(
    input.config?.hmacSecret ?? input.env[TELEGRAM_WEBHOOK_HMAC_SECRET_ENV],
  );
  const hmacMaxSkewMs = parseOptionalPositiveInteger(
    input.config?.hmacMaxSkewMs ?? input.env[TELEGRAM_WEBHOOK_HMAC_MAX_SKEW_MS_ENV],
    "telegram webhook hmac max skew",
  );
  const hmacNonceTtlMs = parseOptionalPositiveInteger(
    input.config?.hmacNonceTtlMs ?? input.env[TELEGRAM_WEBHOOK_HMAC_NONCE_TTL_MS_ENV],
    "telegram webhook hmac nonce ttl",
  );
  const hmacConfig = {
    secret: hmacSecret ?? "",
    ...(hmacMaxSkewMs !== undefined ? { maxSkewMs: hmacMaxSkewMs } : {}),
    ...(hmacNonceTtlMs !== undefined ? { nonceTtlMs: hmacNonceTtlMs } : {}),
  };
  const bearerConfig = {
    token: bearerToken ?? "",
  };

  const inferredMode =
    authMode ??
    (() => {
      if (bearerToken && hmacSecret) return "both";
      if (hmacSecret) return "hmac";
      if (bearerToken) return "bearer";
      return "";
    })();

  if (inferredMode === "hmac") {
    if (!hmacSecret) {
      throw new Error(`${TELEGRAM_WEBHOOK_HMAC_SECRET_ENV} is required for webhook hmac mode`);
    }
    return {
      mode: "hmac",
      hmac: hmacConfig,
    };
  }
  if (inferredMode === "bearer") {
    if (!bearerToken) {
      throw new Error(`${TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV} is required for webhook bearer mode`);
    }
    return {
      mode: "bearer",
      bearer: bearerConfig,
    };
  }
  if (inferredMode === "both") {
    if (!bearerToken || !hmacSecret) {
      throw new Error(
        `${TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV} and ${TELEGRAM_WEBHOOK_HMAC_SECRET_ENV} are required for webhook both mode`,
      );
    }
    return {
      mode: "both",
      bearer: bearerConfig,
      hmac: hmacConfig,
    };
  }

  throw new Error(
    `telegram webhook auth is not configured; set ${TELEGRAM_WEBHOOK_BEARER_TOKEN_ENV} and/or ${TELEGRAM_WEBHOOK_HMAC_SECRET_ENV}`,
  );
}

export function resolveTelegramWebhookIngressConfig(
  telegram: TelegramChannelModeConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTelegramWebhookIngressConfig | null {
  const webhook = telegram?.webhook;
  const envEnabled = isTruthyFlag(env[TELEGRAM_WEBHOOK_ENABLED_ENV]);
  const configEnabled = webhook?.enabled === true;
  const explicitPort = parseOptionalPositiveInteger(
    webhook?.port ?? env[TELEGRAM_WEBHOOK_PORT_ENV],
    "telegram webhook ingress port",
  );
  const enabled = configEnabled || envEnabled || explicitPort !== undefined;
  if (!enabled) {
    return null;
  }

  const host =
    normalizeOptionalText(webhook?.host ?? env[TELEGRAM_WEBHOOK_HOST_ENV]) ??
    TELEGRAM_WEBHOOK_DEFAULT_HOST;
  const port = explicitPort ?? TELEGRAM_WEBHOOK_DEFAULT_PORT;
  if (port > 65535) {
    throw new Error("telegram webhook ingress port must be <= 65535");
  }
  const path =
    normalizeOptionalText(webhook?.path ?? env[TELEGRAM_WEBHOOK_PATH_ENV]) ??
    TELEGRAM_WEBHOOK_DEFAULT_PATH;
  const maxBodyBytes = parseOptionalPositiveInteger(
    webhook?.maxBodyBytes ?? env[TELEGRAM_WEBHOOK_MAX_BODY_BYTES_ENV],
    "telegram webhook max body bytes",
  );

  return {
    host,
    port,
    path,
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    auth: resolveTelegramWebhookAuth({
      config: webhook,
      env,
    }),
  };
}

function listenServer(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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

const CHANNEL_LAUNCHERS: Record<SupportedChannel, ChannelModeLauncher> = {
  telegram: (input) => {
    const telegram = input.channelConfig?.telegram;
    const telegramToken = normalizeText(telegram?.token);
    if (!telegramToken) {
      throw new Error("--telegram-token is required when --channel telegram is set.");
    }
    const apiBaseUrl = normalizeOptionalText(
      telegram?.apiBaseUrl ?? process.env[TELEGRAM_API_BASE_URL_ENV],
    );
    const callbackSecret = normalizeText(telegram?.callbackSecret) || undefined;
    const webhookIngress = resolveTelegramWebhookIngressConfig(telegram);
    if (!webhookIngress) {
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
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
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
    }

    const webhookTransport = new TelegramWebhookTransport({
      token: telegramToken,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      onError: input.onAdapterError,
    });
    const bridgeBundle = createRuntimeTelegramChannelBridge({
      runtime: input.runtime,
      transportInstance: webhookTransport,
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
      resolveIngestedSessionId: input.resolveIngestedSessionId,
      onInboundTurn: input.onInboundTurn,
      onAdapterError: input.onAdapterError,
    });

    const ingressServer = createTelegramIngressServer({
      auth: webhookIngress.auth,
      path: webhookIngress.path,
      maxBodyBytes: webhookIngress.maxBodyBytes,
      onUpdate: async (update) => {
        const accepted = await webhookTransport.ingest(update);
        if (!accepted.accepted) {
          throw new Error("telegram webhook transport is not running");
        }
      },
      onError: input.onAdapterError,
    });

    let ingressStarted = false;
    return {
      ...bridgeBundle,
      onStart: async () => {
        if (ingressStarted) return;
        await listenServer(ingressServer, webhookIngress.host, webhookIngress.port);
        ingressStarted = true;
        input.runtime.events.record({
          sessionId: "channel:system",
          type: "channel_ingress_started",
          payload: {
            channel: "telegram",
            host: webhookIngress.host,
            port: webhookIngress.port,
            path: webhookIngress.path,
            authMode: webhookIngress.auth.mode,
          },
          skipTapeCheckpoint: true,
        });
      },
      onStop: async () => {
        if (!ingressStarted) return;
        await closeServer(ingressServer);
        ingressStarted = false;
        input.runtime.events.record({
          sessionId: "channel:system",
          type: "channel_ingress_stopped",
          payload: {
            channel: "telegram",
          },
          skipTapeCheckpoint: true,
        });
      },
    };
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
  const verdict = resolveToolDisplayVerdict({
    isError: input.isError,
    result: input.result,
  });
  const status = resolveToolDisplayStatus({
    isError: input.isError,
    result: input.result,
  });
  const detail = clampText(
    resolveToolDisplayText({
      toolName: input.toolName,
      isError: input.isError,
      result: input.result,
    }),
    1200,
  );
  const text = detail
    ? `Tool ${input.toolName} (${input.toolCallId}) ${status}\n${detail}`
    : `Tool ${input.toolName} (${input.toolCallId}) ${status}`;
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    isError: input.isError,
    verdict,
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

export function buildChannelDispatchPrompt(input: {
  turn: TurnEnvelope;
  agentSessionId: string;
  skillPolicyState?: TelegramChannelSkillPolicyState;
}): {
  canonicalTurn: TurnEnvelope;
  prompt: string;
} {
  const canonicalTurn = canonicalizeInboundTurnSession(input.turn, input.agentSessionId);
  const prompt = [
    buildChannelSkillPolicyBlock(canonicalTurn, input.skillPolicyState),
    buildInboundPrompt(canonicalTurn),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    canonicalTurn,
    prompt,
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
  session: HostedSessionResult["session"],
  prompt: string,
  options?: {
    runtime?: BrewvaRuntime;
    sessionId?: string;
    turnId?: string;
  },
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
    await sendPromptWithCompactionRecovery(session, prompt, {
      runtime: options?.runtime,
      sessionId: options?.sessionId,
      turnId: options?.turnId,
    });
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });
  await Promise.race([
    Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

export function createSerializedAsyncTaskRunner(task: () => Promise<void>): {
  run: () => Promise<boolean>;
  whenIdle: () => Promise<void>;
} {
  let inFlight: Promise<void> | null = null;

  return {
    async run(): Promise<boolean> {
      if (inFlight) {
        return false;
      }
      inFlight = (async () => {
        try {
          await task();
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
      return true;
    },
    async whenIdle(): Promise<void> {
      await inFlight;
    },
  };
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
    governancePort: createTrustedLocalGovernancePort(),
  });
  options.onRuntimeReady?.(runtime);

  const telegramSkillPolicyState = resolveTelegramChannelSkillPolicyState({
    availableSkillNames: runtime.skills.list().map((skill) => skill.name),
  });
  if (channel === "telegram" && telegramSkillPolicyState.missingSkillNames.length > 0) {
    runtime.events.record({
      sessionId: "channel:system",
      type: "channel_skill_policy_degraded",
      payload: {
        channel: "telegram",
        missingSkillNames: telegramSkillPolicyState.missingSkillNames,
      },
      skipTapeCheckpoint: true,
    });
    if (options.verbose) {
      console.error(
        `[channel:telegram] skill policy degraded: missing skills ${telegramSkillPolicyState.missingSkillNames.join(", ")}`,
      );
    }
  }

  const createSession = options.dependencies?.createSession ?? createHostedSession;
  const collectPromptOutputs =
    options.dependencies?.collectPromptTurnOutputs ?? collectPromptTurnOutputs;
  const channelLaunchers: Record<SupportedChannel, ChannelModeLauncher> = {
    ...CHANNEL_LAUNCHERS,
    ...options.dependencies?.launchers,
  };

  const orchestrationConfig = resolveChannelOrchestrationConfig(runtime);
  const scopeStrategy = orchestrationConfig.enabled ? orchestrationConfig.scopeStrategy : "chat";
  const conversationBindings = ConversationBindingStore.create({
    workspaceRoot: runtime.workspaceRoot,
  });
  const addonHost = new AddonHost({
    cwd: runtime.workspaceRoot,
  });
  await addonHost.loadAll();
  addonHost.startJobs();

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
  const turnWalMaintenance = createSerializedAsyncTaskRunner(async () => {
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
  });

  const sessions = new Map<string, ConversationSessionState>();
  const sessionByAgentSessionId = new Map<string, ConversationSessionState>();
  const createSessionTasks = new Map<string, Promise<ConversationSessionState>>();
  const scopeQueues = new Map<string, Promise<void>>();
  const lastTurnByScope = new Map<string, TurnEnvelope>();
  let shuttingDown = false;

  let bundle: ChannelModeLaunchBundle;

  const resolveScopeKey = (turn: TurnEnvelope): string => {
    const conversationKey = buildRoutingScopeKey(turn, scopeStrategy);
    const existingScopeId = conversationBindings.resolveScopeId(conversationKey);
    if (existingScopeId) {
      return existingScopeId;
    }
    const created = conversationBindings.ensureBinding({
      conversationKey,
      proposedScopeId: conversationKey,
      channel: turn.channel,
      conversationId: turn.conversationId,
      threadId: turn.threadId,
    });
    runtime.events.record({
      sessionId: turnWalStore.scope,
      type: "channel_conversation_bound",
      payload: {
        channel: created.channel,
        conversationId: created.conversationId,
        threadId: created.threadId,
        conversationKey: created.conversationKey,
        scopeId: created.scopeId,
      },
      skipTapeCheckpoint: true,
    });
    return created.scopeId;
  };

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
      const result = await createSession({
        cwd: options.cwd,
        configPath: options.configPath,
        model,
        enableExtensions: options.enableExtensions,
        runtime: workerRuntime,
        addonHost,
        scopeId: scopeKey,
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
        return collectPromptOutputs(state.result.session, input.prompt, {
          runtime: state.result.runtime,
          sessionId: state.agentSessionId,
          turnId: input.turn.turnId,
        });
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
    const { canonicalTurn, prompt } = buildChannelDispatchPrompt({
      turn,
      agentSessionId: state.agentSessionId,
      skillPolicyState: telegramSkillPolicyState,
    });

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
      return collectPromptOutputs(state.result.session, prompt, {
        runtime: state.result.runtime,
        sessionId: state.agentSessionId,
        turnId: canonicalTurn.turnId,
      });
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
          toolVerdict: toolOutput.verdict,
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

    const scopeKey = resolveScopeKey(turn);
    const previous = scopeQueues.get(scopeKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await processInboundTurn(turn, walId, scopeKey);
      });
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    scopeQueues.set(scopeKey, settled);
    void settled.finally(() => {
      if (scopeQueues.get(scopeKey) === settled) {
        scopeQueues.delete(scopeKey);
      }
    });

    if (enqueueOptions.awaitCompletion) {
      await next;
    }
  };

  try {
    bundle = channelLaunchers[channel]({
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
        const scopeKey = resolveScopeKey(turn);
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
    addonHost.stopJobs();
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
      void turnWalMaintenance.run();
    }, turnWalCompactIntervalMs);
    turnWalCompactTimer.unref?.();
  }

  try {
    await bundle.bridge.start();
    await bundle.onStart?.();
  } catch (error) {
    if (turnWalCompactTimer) {
      clearInterval(turnWalCompactTimer);
      turnWalCompactTimer = null;
    }
    await turnWalMaintenance.whenIdle();
    addonHost.stopJobs();
    await Promise.allSettled([bundle.onStop?.(), bundle.bridge.stop()]);
    console.error(`Error: ${toErrorMessage(error)}`);
    process.exitCode = 1;
    return;
  }
  if (options.verbose) {
    console.error(`[channel] ${channel} bridge started`);
  }

  await new Promise<void>((complete) => {
    let stopping = false;
    let removeAbortListener: (() => void) | null = null;
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
        await turnWalMaintenance.whenIdle();
        await bundle.onStop?.();
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
        addonHost.stopJobs();

        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
        removeAbortListener?.();
        removeAbortListener = null;
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

    if (options.shutdownSignal) {
      const onAbort = () => shutdown("SIGTERM");
      options.shutdownSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        options.shutdownSignal?.removeEventListener("abort", onAbort);
      };
      if (options.shutdownSignal.aborted) {
        shutdown("SIGTERM");
      }
    }
  });
}
